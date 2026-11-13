package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Setup installs the Linux environment on Android, step by step. Each step
// leaves a marker file so an interrupted setup resumes where it stopped.
type Setup struct {
	app *App

	mu       sync.Mutex
	running  bool
	step     string
	errMsg   string
	progress float64 // 0..1 within the current step, -1 when unknown
	detail   string
	logs     []string
	cancel   context.CancelFunc
}

type setupStep struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	run   func(*Setup, context.Context) error
}

var setupSteps []setupStep

func init() {
	setupSteps = []setupStep{
		{ID: "runtime", Label: "Download proot (Linux runtime)", run: (*Setup).stepRuntime},
		{ID: "rootfs", Label: "Download and unpack Ubuntu 24.04", run: (*Setup).stepRootfs},
		{ID: "configure", Label: "Configure Ubuntu for Android", run: (*Setup).stepConfigure},
		{ID: "packages", Label: "Install git, curl, ripgrep, python", run: (*Setup).stepPackages},
		{ID: "claude", Label: "Install Claude Code (official installer)", run: (*Setup).stepClaude},
	}
}

var termuxMirrors = []string{
	"https://packages-cf.termux.dev/apt/termux-main",
	"https://packages.termux.dev/apt/termux-main",
	"https://grimler.se/termux/termux-main",
}

const corePackages = "ca-certificates curl wget git ripgrep less nano vim-tiny procps psmisc unzip zip xz-utils openssh-client python3 python3-venv file jq tree gh"

func newSetup(a *App) *Setup { return &Setup{app: a, progress: -1} }

func (s *Setup) marker(id string) string { return s.app.cfg.path("runtime", "step-"+id+".done") }

type stepState struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	State string `json:"state"` // done | running | pending | failed
}

func (s *Setup) snapshot() map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	steps := []stepState{}
	for _, st := range setupSteps {
		state := "pending"
		if _, err := os.Stat(s.marker(st.ID)); err == nil {
			state = "done"
		} else if s.running && s.step == st.ID {
			state = "running"
		} else if !s.running && s.errMsg != "" && s.step == st.ID {
			state = "failed"
		}
		steps = append(steps, stepState{st.ID, st.Label, state})
	}
	logs := s.logs
	if len(logs) > 400 {
		logs = logs[len(logs)-400:]
	}
	return map[string]any{
		"needed":   s.app.cfg.Android,
		"running":  s.running,
		"step":     s.step,
		"error":    s.errMsg,
		"progress": s.progress,
		"detail":   s.detail,
		"steps":    steps,
		"logs":     logs,
		"done":     s.app.setupComplete(),
		"ready":    s.app.ready(),
	}
}

func (s *Setup) publish() {
	snap := s.snapshot()
	snap["type"] = "setup"
	// keep event payloads small; the UI fetches full logs from /api/setup/state
	if l, ok := snap["logs"].([]string); ok && len(l) > 40 {
		snap["logs"] = l[len(l)-40:]
	}
	s.app.events.publish(snap)
}

func (s *Setup) logf(format string, args ...any) {
	line := fmt.Sprintf(format, args...)
	log.Printf("setup: %s", line)
	s.mu.Lock()
	s.logs = append(s.logs, line)
	if len(s.logs) > 3000 {
		s.logs = s.logs[len(s.logs)-3000:]
	}
	s.mu.Unlock()
	s.publish()
}

func (s *Setup) setProgress(p float64, detail string) {
	s.mu.Lock()
	s.progress, s.detail = p, detail
	s.mu.Unlock()
	s.publish()
}

func (s *Setup) handleState(w http.ResponseWriter, r *http.Request) { writeJSON(w, s.snapshot()) }

func (s *Setup) handleStart(w http.ResponseWriter, r *http.Request) {
	var req struct {
		From string `json:"from"` // rerun from this step (e.g. "claude" to reinstall)
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	if !s.app.cfg.Android {
		writeJSON(w, map[string]any{"ok": true, "note": "setup is only needed on Android"})
		return
	}
	s.mu.Lock()
	if s.running {
		s.mu.Unlock()
		writeJSON(w, map[string]any{"ok": true, "note": "already running"})
		return
	}
	if req.From != "" {
		found := false
		for _, st := range setupSteps {
			if st.ID == req.From {
				found = true
			}
			if found {
				_ = os.Remove(s.marker(st.ID))
			}
		}
		_ = os.Remove(s.app.cfg.path("runtime", "setup.done"))
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.running, s.errMsg, s.cancel = true, "", cancel
	s.mu.Unlock()
	go s.run(ctx)
	writeJSON(w, map[string]any{"ok": true})
}

func (s *Setup) run(ctx context.Context) {
	defer func() {
		s.mu.Lock()
		s.running = false
		s.progress = -1
		s.mu.Unlock()
		s.publish()
	}()
	s.logf("Skiff %s setup on %s/%s", version, runtime.GOOS, runtime.GOARCH)
	for _, st := range setupSteps {
		if _, err := os.Stat(s.marker(st.ID)); err == nil {
			continue
		}
		s.mu.Lock()
		s.step = st.ID
		s.mu.Unlock()
		s.setProgress(-1, "")
		s.logf("▶ %s", st.Label)
		start := time.Now()
		if err := st.run(s, ctx); err != nil {
			s.mu.Lock()
			s.errMsg = err.Error()
			s.mu.Unlock()
			s.logf("✖ %s failed: %v", st.Label, err)
			return
		}
		_ = os.WriteFile(s.marker(st.ID), []byte(time.Now().Format(time.RFC3339)), 0o644)
		s.logf("✔ %s (%s)", st.Label, time.Since(start).Round(time.Second))
	}
	_ = os.WriteFile(s.app.cfg.path("runtime", "setup.done"), []byte(version), 0o644)
	go s.app.registerPhoneMCP()
	s.mu.Lock()
	s.step = ""
	s.mu.Unlock()
	s.logf("All set. Open Terminal → Claude and run /login, or start a Chat.")
}

func termuxArch() string {
	switch runtime.GOARCH {
	case "arm64":
		return "aarch64"
	case "amd64":
		return "x86_64"
	case "arm":
		return "arm"
	}
	return runtime.GOARCH
}

func ubuntuArch() string {
	switch runtime.GOARCH {
	case "arm":
		return "armhf"
	}
	return runtime.GOARCH
}

// stepRuntime fetches proot and the libraries it needs from Termux's
// package repository, built for Android.
func (s *Setup) stepRuntime(ctx context.Context) error {
	rt := s.app.cfg.path("runtime")
	var idx map[string]debPackage
	var mirror string
	for _, m := range termuxMirrors {
		for _, name := range []string{"Packages", "Packages.xz", "Packages.gz"} {
			url := fmt.Sprintf("%s/dists/stable/main/binary-%s/%s", m, termuxArch(), name)
			s.logf("index: %s", url)
			b, err := fetch(ctx, url)
			if err != nil {
				s.logf("  %v", err)
				continue
			}
			r, err := decompress(name, strings.NewReader(string(b)))
			if err != nil {
				continue
			}
			raw, err := io.ReadAll(r)
			if err != nil {
				continue
			}
			idx = parsePackages(raw)
			if _, ok := idx["proot"]; ok {
				mirror = m
				break
			}
		}
		if mirror != "" {
			break
		}
	}
	if mirror == "" {
		return errors.New("could not read the Termux package index from any mirror (check the internet connection)")
	}
	// resolve proot and its dependencies
	want := []string{"proot"}
	seen := map[string]bool{}
	var pkgs []debPackage
	for len(want) > 0 && len(pkgs) < 12 {
		n := want[0]
		want = want[1:]
		if seen[n] {
			continue
		}
		seen[n] = true
		p, ok := idx[n]
		if !ok {
			s.logf("  (skipping unknown dependency %s)", n)
			continue
		}
		pkgs = append(pkgs, p)
		want = append(want, depNames(p.Depends)...)
	}
	const prefix = "data/data/com.termux/files/usr/"
	for i, p := range pkgs {
		s.logf("package %s %s", p.Name, p.Version)
		dst := s.app.cfg.path("tmp", filepath.Base(p.Filename))
		err := download(ctx, mirror+"/"+p.Filename, dst, p.SHA256, func(d, t int64) {
			s.setProgress((float64(i)+frac(d, t))/float64(len(pkgs)), fmt.Sprintf("%s %s", p.Name, sizeStr(d, t)))
		})
		if err != nil {
			return err
		}
		r, _, err := debData(dst)
		if err != nil {
			return fmt.Errorf("%s: %w", p.Name, err)
		}
		err = extractTar(r, rt, func(name string) string {
			name = strings.TrimPrefix(strings.TrimPrefix(name, "./"), "/")
			if !strings.HasPrefix(name, prefix) {
				return ""
			}
			rel := strings.TrimPrefix(name, prefix)
			if strings.HasPrefix(rel, "bin/") || strings.HasPrefix(rel, "lib/") || strings.HasPrefix(rel, "libexec/") {
				if strings.HasPrefix(rel, "lib/pkgconfig") || strings.HasSuffix(rel, ".a") {
					return ""
				}
				return rel
			}
			return ""
		}, nil)
		os.Remove(dst)
		if err != nil {
			return fmt.Errorf("%s: %w", p.Name, err)
		}
	}
	if _, err := os.Stat(filepath.Join(rt, "bin", "proot")); err != nil {
		return errors.New("proot binary missing after extraction")
	}
	_ = os.Chmod(filepath.Join(rt, "bin", "proot"), 0o755)
	_ = filepath.Walk(filepath.Join(rt, "libexec"), func(p string, info os.FileInfo, err error) error {
		if err == nil && !info.IsDir() {
			_ = os.Chmod(p, 0o755)
		}
		return nil
	})
	return nil
}

var ubuntuBaseRe = regexp.MustCompile(`ubuntu-base-24\.04(?:\.(\d+))?-base-` + ubuntuArch() + `\.tar\.gz`)

func (s *Setup) stepRootfs(ctx context.Context) error {
	rootfs := s.app.cfg.Rootfs()
	var url, sum string
	for _, dir := range []string{
		"https://cdimage.ubuntu.com/ubuntu-base/releases/24.04/release/",
		"https://cdimage.ubuntu.com/ubuntu-base/releases/noble/release/",
	} {
		b, err := fetch(ctx, dir)
		if err != nil {
			s.logf("  %v", err)
			continue
		}
		best, bestN := "", -1
		for _, m := range ubuntuBaseRe.FindAllStringSubmatch(string(b), -1) {
			n := 0
			if m[1] != "" {
				n, _ = strconv.Atoi(m[1])
			}
			if n > bestN {
				best, bestN = m[0], n
			}
		}
		if best == "" {
			continue
		}
		url = dir + best
		if sums, err := fetch(ctx, dir+"SHA256SUMS"); err == nil {
			for _, line := range strings.Split(string(sums), "\n") {
				f := strings.Fields(line)
				if len(f) == 2 && strings.TrimPrefix(f[1], "*") == best {
					sum = f[0]
				}
			}
		}
		break
	}
	if url == "" {
		return errors.New("could not find the Ubuntu base image on cdimage.ubuntu.com")
	}
	s.logf("image: %s", url)
	dst := s.app.cfg.path("tmp", "ubuntu-base.tar.gz")
	if err := download(ctx, url, dst, sum, func(d, t int64) {
		s.setProgress(frac(d, t), "Ubuntu "+sizeStr(d, t))
	}); err != nil {
		return err
	}
	_ = os.RemoveAll(rootfs)
	if err := os.MkdirAll(rootfs, 0o755); err != nil {
		return err
	}
	f, err := os.Open(dst)
	if err != nil {
		return err
	}
	defer f.Close()
	r, err := decompress(dst, f)
	if err != nil {
		return err
	}
	s.setProgress(-1, "unpacking")
	if err := extractTar(r, rootfs, nil, func(n int) { s.setProgress(-1, fmt.Sprintf("unpacked %d files", n)) }); err != nil {
		return err
	}
	os.Remove(dst)
	return nil
}

func (s *Setup) stepConfigure(ctx context.Context) error {
	root := s.app.cfg.Rootfs()
	w := func(p, content string, mode os.FileMode) error {
		full := filepath.Join(root, p)
		_ = os.MkdirAll(filepath.Dir(full), 0o755)
		_ = os.Remove(full)
		return os.WriteFile(full, []byte(content), mode)
	}
	_ = os.MkdirAll(filepath.Join(root, "tmp"), 0o777)
	_ = os.Chmod(filepath.Join(root, "tmp"), 0o1777)

	var ns strings.Builder
	for _, d := range s.app.cfg.DNS {
		if ip := net.ParseIP(d); ip != nil {
			ns.WriteString("nameserver " + d + "\n")
		}
	}
	ns.WriteString("nameserver 1.1.1.1\nnameserver 8.8.8.8\n")
	files := []struct {
		path, content string
		mode          os.FileMode
	}{
		{"etc/resolv.conf", ns.String(), 0o644},
		{"etc/hosts", "127.0.0.1 localhost\n::1 localhost ip6-localhost ip6-loopback\n", 0o644},
		{"etc/hostname", "skiff\n", 0o644},
		{"etc/apt/apt.conf.d/99skiff", "APT::Sandbox::User \"root\";\nAcquire::Retries \"3\";\nAPT::Install-Recommends \"false\";\nDpkg::Options { \"--force-confdef\"; \"--force-confold\"; };\n", 0o644},
		{"usr/local/bin/skiff-open", "#!/bin/sh\nexec /opt/skiff/libskiffd.so open \"$@\"\n", 0o755},
		{"etc/profile.d/skiff.sh", skiffProfile, 0o644},
		{"etc/apt/sources.list.d/ubuntu.sources", ubuntuSources(), 0o644},
		{"etc/apt/sources.list", "# see /etc/apt/sources.list.d/ubuntu.sources\n", 0o644},
	}
	for _, f := range files {
		if err := w(f.path, f.content, f.mode); err != nil {
			return err
		}
	}
	_ = os.Remove(filepath.Join(root, "usr/local/bin/xdg-open"))
	_ = os.Symlink("skiff-open", filepath.Join(root, "usr/local/bin/xdg-open"))
	_ = os.MkdirAll(filepath.Join(root, "root/projects"), 0o755)

	// name Android's supplementary groups so tools stop printing
	// "cannot find name for group ID"
	if gids, err := os.Getgroups(); err == nil {
		var g, gs strings.Builder
		g.WriteString("\n")
		for _, id := range append(gids, os.Getgid()) {
			if id == 0 {
				continue
			}
			fmt.Fprintf(&g, "aid_%d:x:%d:root\n", id, id)
			fmt.Fprintf(&gs, "aid_%d:*::root\n", id)
		}
		appendFile(filepath.Join(root, "etc/group"), g.String())
		appendFile(filepath.Join(root, "etc/gshadow"), gs.String())
	}
	bashrc := filepath.Join(root, "root/.bashrc")
	if b, _ := os.ReadFile(bashrc); !strings.Contains(string(b), "skiff") {
		appendFile(bashrc, "\n# skiff\n. /etc/profile.d/skiff.sh\n")
	}
	return nil
}

// ubuntuSources enables all components (ripgrep, jq and many dev tools live
// in universe) on the right mirror for the CPU.
func ubuntuSources() string {
	main, sec := "http://archive.ubuntu.com/ubuntu/", "http://security.ubuntu.com/ubuntu/"
	if runtime.GOARCH != "amd64" && runtime.GOARCH != "386" {
		main, sec = "http://ports.ubuntu.com/ubuntu-ports/", "http://ports.ubuntu.com/ubuntu-ports/"
	}
	return "Types: deb\nURIs: " + main + "\nSuites: noble noble-updates noble-backports\nComponents: main restricted universe multiverse\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n\n" +
		"Types: deb\nURIs: " + sec + "\nSuites: noble-security\nComponents: main restricted universe multiverse\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n"
}

const skiffProfile = `# Skiff environment
export PATH="$HOME/.local/bin:$PATH"
export BROWSER=/usr/local/bin/skiff-open
export COLORTERM=truecolor
if [ -n "$BASH_VERSION" ] && [ -n "$PS1" ]; then
  PS1='\[\e[38;5;79m\]\w\[\e[0m\] \[\e[38;5;245m\]$\[\e[0m\] '
fi
`

func appendFile(p, s string) {
	f, err := os.OpenFile(p, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.WriteString(s)
}

// runGuest runs a shell script inside Ubuntu, streaming output to the setup log.
func (s *Setup) runGuest(ctx context.Context, script string) error {
	cmd, err := s.app.guestCommand([]string{"/bin/bash", "-c", script}, "/root", map[string]string{"DEBIAN_FRONTEND": "noninteractive"})
	if err != nil {
		return err
	}
	pr, pw := io.Pipe()
	cmd.Stdout, cmd.Stderr = pw, pw
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() {
		<-ctx.Done()
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
	}()
	done := make(chan struct{})
	go func() {
		defer close(done)
		sc := bufio.NewScanner(pr)
		sc.Buffer(make([]byte, 64<<10), 1<<20)
		sc.Split(scanLinesCR)
		for sc.Scan() {
			if t := strings.TrimSpace(sc.Text()); t != "" && !strings.HasPrefix(t, "proot warning:") {
				s.logf("  %s", t)
			}
		}
	}()
	err = cmd.Wait()
	pw.Close()
	<-done
	return err
}

// scanLinesCR splits on \n and \r so progress bars become separate lines.
func scanLinesCR(data []byte, atEOF bool) (int, []byte, error) {
	for i, c := range data {
		if c == '\n' || c == '\r' {
			return i + 1, data[:i], nil
		}
	}
	if atEOF && len(data) > 0 {
		return len(data), data, nil
	}
	return 0, nil, nil
}

func (s *Setup) stepPackages(ctx context.Context) error {
	s.setProgress(-1, "apt-get update")
	if err := s.runGuest(ctx, "apt-get update"); err != nil {
		return fmt.Errorf("apt-get update: %w", err)
	}
	s.setProgress(-1, "apt-get install")
	return s.runGuest(ctx, "apt-get install -y "+corePackages+" && (command -v rg >/dev/null || true)")
}

func (s *Setup) stepClaude(ctx context.Context) error {
	s.setProgress(-1, "running claude.ai/install.sh")
	if err := s.runGuest(ctx, "set -o pipefail; curl -fsSL https://claude.ai/install.sh | bash"); err != nil {
		return fmt.Errorf("Claude Code installer: %w", err)
	}
	if !s.app.claudeInstalled() {
		return errors.New("the installer finished but ~/.local/bin/claude is missing")
	}
	_ = s.runGuest(ctx, "~/.local/bin/claude --version || true")
	return nil
}

func frac(d, t int64) float64 {
	if t <= 0 {
		return 0
	}
	return float64(d) / float64(t)
}

func sizeStr(d, t int64) string {
	mb := func(n int64) string { return fmt.Sprintf("%.1f MB", float64(n)/(1<<20)) }
	if t > 0 {
		return mb(d) + " / " + mb(t)
	}
	return mb(d)
}

var _ = sort.Strings
