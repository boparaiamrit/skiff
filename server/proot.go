package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
)

// hostPath maps a path inside the Linux environment to the real path on
// the device. On a dev machine they are the same.
func (a *App) hostPath(guest string) string {
	guest = filepath.Clean("/" + guest)
	if !a.cfg.Android {
		return guest
	}
	for _, p := range []string{"/sdcard", "/storage"} {
		if guest == p || strings.HasPrefix(guest, p+"/") {
			return guest
		}
	}
	return filepath.Join(a.cfg.Rootfs(), guest)
}

// guestEnv is the environment every process in the Linux environment gets.
func (a *App) guestEnv(extra map[string]string) []string {
	home := a.guestHome()
	path := home + "/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
	env := map[string]string{
		"HOME":        home,
		"TERM":        "xterm-256color",
		"COLORTERM":   "truecolor",
		"LANG":        "C.UTF-8",
		"LC_ALL":      "C.UTF-8",
		"SKIFF_URL":   fmt.Sprintf("http://127.0.0.1:%d", a.cfg.Port),
		"SKIFF_TOKEN": a.cfg.Token,
		"SKIFF":       "1",
	}
	if a.cfg.Android {
		env["USER"] = "root"
		env["LOGNAME"] = "root"
		env["SHELL"] = "/bin/bash"
		env["TMPDIR"] = "/tmp"
		env["PATH"] = path
		env["BROWSER"] = "/usr/local/bin/skiff-open"
	} else {
		for _, k := range []string{"USER", "LOGNAME", "SHELL"} {
			env[k] = os.Getenv(k)
		}
		env["PATH"] = a.cfg.path("runtime", "bin") + ":" + home + "/.local/bin:" + os.Getenv("PATH")
		env["BROWSER"] = a.cfg.path("runtime", "bin", "skiff-open")
		if env["SHELL"] == "" {
			env["SHELL"] = "/bin/bash"
		}
	}
	for k, v := range extra {
		env[k] = v
	}
	out := make([]string, 0, len(env))
	for k, v := range env {
		out = append(out, k+"="+v)
	}
	return out
}

var (
	prootFlagsOnce sync.Once
	prootFlags     string
)

// guestCommand builds a command that runs argv inside the Linux
// environment with working directory cwd (a guest path).
func (a *App) guestCommand(argv []string, cwd string, extra map[string]string) (*exec.Cmd, error) {
	// SKIFF_USER=1 runs the command as a normal user (uid 1000) instead of
	// proot's fake root. Claude Code refuses --dangerously-skip-permissions
	// as root, and an agent is better off without (even fake) root anyway.
	asUser := extra["SKIFF_USER"] != ""
	if asUser && a.cfg.Android {
		name := a.ensureGuestUser()
		extra["SKIFF_USER"] = name
		extra["USER"] = name
		extra["LOGNAME"] = name
	}
	env := a.guestEnv(extra)
	if !a.cfg.Android {
		if err := a.ensureDevHelpers(); err != nil {
			return nil, err
		}
		cmd := exec.Command(argv[0], argv[1:]...)
		cmd.Env = env
		cmd.Dir = cwd
		if st, err := os.Stat(cwd); err != nil || !st.IsDir() {
			cmd.Dir = a.guestHome()
		}
		return cmd, nil
	}

	rt := a.cfg.path("runtime")
	rootfs := a.cfg.Rootfs()
	proot := filepath.Join(rt, "bin", "proot")
	if _, err := os.Stat(proot); err != nil {
		return nil, fmt.Errorf("the Linux environment is not installed yet")
	}
	prootFlagsOnce.Do(func() {
		c := exec.Command(proot, "--help")
		c.Env = a.prootHostEnv()
		out, _ := c.CombinedOutput()
		prootFlags = string(out)
	})
	has := func(f string) bool { return strings.Contains(prootFlags, f) }

	if st, err := os.Stat(a.hostPath(cwd)); err != nil || !st.IsDir() {
		cwd = a.guestHome()
	}
	args := []string{"-0"}
	if asUser {
		args = []string{"-i", "1000:1000"}
	}
	if has("--kill-on-exit") {
		args = append(args, "--kill-on-exit")
	}
	if has("--link2symlink") {
		args = append(args, "--link2symlink")
	}
	if has("--sysvipc") {
		args = append(args, "--sysvipc")
	}
	if has("\n  -L") || has(" -L,") {
		args = append(args, "-L")
	}
	if has("--kernel-release") {
		args = append(args, "--kernel-release=6.17.0-skiff")
	}
	args = append(args, "-r", rootfs,
		"-b", "/dev", "-b", "/proc", "-b", "/sys",
		"-b", "/dev/urandom:/dev/random",
		"-b", "/proc/self/fd:/dev/fd",
		"-b", "/proc/self/fd/0:/dev/stdin",
		"-b", "/proc/self/fd/1:/dev/stdout",
		"-b", "/proc/self/fd/2:/dev/stderr",
		"-b", filepath.Join(rootfs, "tmp")+":/dev/shm",
		"-b", a.cfg.NativeDir+":/opt/skiff",
	)
	for _, p := range []string{"/system", "/apex", "/vendor", "/linkerconfig"} {
		if _, err := os.Stat(p); err == nil {
			args = append(args, "-b", p)
		}
	}
	if st, err := os.Stat("/storage/emulated/0"); err == nil && st.IsDir() {
		if _, err := os.ReadDir("/storage/emulated/0"); err == nil {
			args = append(args, "-b", "/storage/emulated/0:/sdcard", "-b", "/storage")
		}
	}
	args = append(args, a.procFakes()...)
	args = append(args, "-w", cwd, "/usr/bin/env", "-i")
	args = append(args, env...)
	args = append(args, argv...)

	cmd := exec.Command(proot, args...)
	cmd.Env = a.prootHostEnv()
	cmd.Dir = a.cfg.Home
	return cmd, nil
}

// ensureGuestUser makes sure uid/gid 1000 have names in Ubuntu and returns
// the user name. The user keeps HOME=/root so Claude Code finds the login it
// made there; every file really belongs to the app, so access is unchanged.
func (a *App) ensureGuestUser() string {
	root := a.cfg.Rootfs()
	name := ""
	if b, err := os.ReadFile(filepath.Join(root, "etc/passwd")); err == nil {
		for _, l := range strings.Split(string(b), "\n") {
			if f := strings.Split(l, ":"); len(f) > 3 && f[2] == "1000" {
				name = f[0]
			}
		}
	}
	if name == "" {
		name = "skiff"
		appendFile(filepath.Join(root, "etc/passwd"), "skiff:x:1000:1000:Skiff:/root:/bin/bash\n")
		appendFile(filepath.Join(root, "etc/shadow"), "skiff:*:20000:0:99999:7:::\n")
	}
	hasGroup := false
	if b, err := os.ReadFile(filepath.Join(root, "etc/group")); err == nil {
		for _, l := range strings.Split(string(b), "\n") {
			if f := strings.Split(l, ":"); len(f) > 2 && f[2] == "1000" {
				hasGroup = true
			}
		}
	}
	if !hasGroup {
		appendFile(filepath.Join(root, "etc/group"), name+":x:1000:\n")
	}
	return name
}

func (a *App) prootHostEnv() []string {
	rt := a.cfg.path("runtime")
	env := []string{
		"LD_LIBRARY_PATH=" + filepath.Join(rt, "lib"),
		"PROOT_TMP_DIR=" + a.cfg.path("tmp"),
		"TMPDIR=" + a.cfg.path("tmp"),
		"HOME=" + a.cfg.Home,
		"PATH=/system/bin:/system/xbin:/usr/bin:/bin",
	}
	// Termux's proot looks for its loader under Termux's prefix; point it
	// at ours. (Builds with an embedded loader need neither.)
	if l := filepath.Join(rt, "libexec", "proot", "loader"); fileExists(l) {
		env = append(env, "PROOT_LOADER="+l)
	}
	if l := filepath.Join(rt, "libexec", "proot", "loader32"); fileExists(l) {
		env = append(env, "PROOT_LOADER_32="+l)
	}
	return env
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// procFakes binds stand-ins for /proc files Android's SELinux policy hides
// from apps. Tools like top, ps and npm read them.
func (a *App) procFakes() []string {
	dir := a.cfg.path("runtime", "proc")
	_ = os.MkdirAll(dir, 0o755)
	fakes := map[string]string{
		"/proc/loadavg":                         "0.12 0.07 0.02 2/165 765\n",
		"/proc/stat":                            "cpu  1957 0 2877 93280 262 342 254 87 0 0\ncpu0 1957 0 2877 93280 262 342 254 87 0 0\nintr 0\nctxt 0\nbtime 0\nprocesses 0\nprocs_running 1\nprocs_blocked 0\nsoftirq 0\n",
		"/proc/uptime":                          "124.08 932.80\n",
		"/proc/version":                         "Linux version 6.17.0-skiff (skiff@localhost) #1 SMP PREEMPT Fri Nov 13 00:00:00 UTC 2026\n",
		"/proc/vmstat":                          "nr_free_pages 136777\n",
		"/proc/sys/kernel/cap_last_cap":         "40\n",
		"/proc/sys/fs/inotify/max_user_watches": "524288\n",
	}
	var args []string
	for p, content := range fakes {
		if b, err := os.ReadFile(p); err == nil && len(b) > 0 {
			continue
		}
		f := filepath.Join(dir, strings.ReplaceAll(strings.TrimPrefix(p, "/proc/"), "/", "_"))
		if err := os.WriteFile(f, []byte(content), 0o644); err == nil {
			args = append(args, "-b", f+":"+p)
		}
	}
	return args
}

// ensureDevHelpers writes the skiff-open helper on a dev machine.
func (a *App) ensureDevHelpers() error {
	bin := a.cfg.path("runtime", "bin")
	if err := os.MkdirAll(bin, 0o755); err != nil {
		return err
	}
	script := fmt.Sprintf("#!/bin/sh\nexec %q open \"$@\"\n", a.cfg.Self)
	return os.WriteFile(filepath.Join(bin, "skiff-open"), []byte(script), 0o755)
}
