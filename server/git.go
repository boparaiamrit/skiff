package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path"
	"regexp"
	"strings"
	"sync"
	"time"
)

// GitHub sign-in and repositories, through the official GitHub CLI (gh)
// inside Ubuntu. Sign-in uses gh's device flow: the user types a one-time
// code on github.com, and gh stores the token in ~/.config/gh.

type gitState struct {
	mu        sync.Mutex
	loginBusy bool
	loginCode string
	loginURL  string
	repos     []map[string]any
	reposAt   time.Time
	clones    map[string]bool
}

var gitSt = &gitState{clones: map[string]bool{}}

// runGuestLines runs a shell script inside the Linux environment and calls
// onLine for each output line. Root unless asUser.
func (a *App) runGuestLines(ctx context.Context, script string, asUser bool, stdin string, onLine func(string)) error {
	extra := map[string]string{"DEBIAN_FRONTEND": "noninteractive", "GH_BROWSER": "true", "NO_COLOR": "1"}
	if asUser {
		extra["SKIFF_USER"] = "1"
	}
	cmd, err := a.guestCommand([]string{"/bin/bash", "-lc", script}, a.guestHome(), extra)
	if err != nil {
		return err
	}
	pr, pw := io.Pipe()
	cmd.Stdout, cmd.Stderr = pw, pw
	if stdin != "" {
		cmd.Stdin = strings.NewReader(stdin)
	}
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
		sc.Buffer(make([]byte, 64<<10), 8<<20)
		sc.Split(scanLinesCR)
		for sc.Scan() {
			t := strings.TrimRight(sc.Text(), " ")
			if t != "" && !strings.HasPrefix(t, "proot warning:") && onLine != nil {
				onLine(t)
			}
		}
	}()
	err = cmd.Wait()
	pw.Close()
	<-done
	return err
}

// guestOutput runs a script and returns its combined output.
func (a *App) guestOutput(ctx context.Context, script string) (string, error) {
	var b strings.Builder
	err := a.runGuestLines(ctx, script, false, "", func(l string) { b.WriteString(l + "\n") })
	return b.String(), err
}

func (a *App) ghInstalled() bool {
	if !a.cfg.Android {
		_, err := exec.LookPath("gh")
		return err == nil
	}
	return fileExists(a.hostPath("/usr/bin/gh"))
}

func (a *App) ensureGh(ctx context.Context, onLine func(string)) error {
	if a.ghInstalled() {
		return nil
	}
	if !a.cfg.Android {
		return errors.New("install the GitHub CLI (gh) on this machine first")
	}
	onLine("Installing the GitHub CLI (gh)…")
	return a.runGuestLines(ctx, "apt-get install -y gh || (apt-get update && apt-get install -y gh)", false, "", onLine)
}

func (a *App) handleGitStatus(w http.ResponseWriter, r *http.Request) {
	out := map[string]any{"gh": a.ghInstalled(), "signedIn": false}
	if !a.ready() || !a.ghInstalled() {
		writeJSON(w, out)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	s, err := a.guestOutput(ctx, "gh api user --jq '{login: .login, name: .name, avatar: .avatar_url}' 2>&1")
	if err == nil {
		var u map[string]any
		if json.Unmarshal([]byte(strings.TrimSpace(lastJSON(s))), &u) == nil && u["login"] != nil {
			out["signedIn"] = true
			out["user"] = u
		}
	} else if strings.Contains(s, "gh auth login") || strings.Contains(s, "401") {
		out["signedIn"] = false
	} else {
		out["error"] = strings.TrimSpace(s)
	}
	gitSt.mu.Lock()
	out["loginBusy"] = gitSt.loginBusy
	if gitSt.loginBusy && gitSt.loginCode != "" {
		out["login"] = map[string]any{"state": "code", "code": gitSt.loginCode, "url": gitSt.loginURL}
	}
	gitSt.mu.Unlock()
	writeJSON(w, out)
}

func lastJSON(s string) string {
	for _, l := range strings.Split(strings.TrimSpace(s), "\n") {
		if strings.HasPrefix(strings.TrimSpace(l), "{") {
			s = l
		}
	}
	return s
}

var (
	deviceCodeRe = regexp.MustCompile(`\b([A-Z0-9]{4}-[A-Z0-9]{4})\b`)
	deviceURLRe  = regexp.MustCompile(`https://github\.com/login/device\S*`)
)

// handleGitLogin starts `gh auth login --web` and publishes the one-time
// code to the UI as "gitlogin" events.
func (a *App) handleGitLogin(w http.ResponseWriter, r *http.Request) {
	if !a.ready() {
		httpErr(w, errors.New("finish Setup first"), 400)
		return
	}
	gitSt.mu.Lock()
	if gitSt.loginBusy {
		gitSt.mu.Unlock()
		writeJSON(w, map[string]any{"ok": true, "note": "already running"})
		return
	}
	gitSt.loginBusy = true
	gitSt.mu.Unlock()
	writeJSON(w, map[string]any{"ok": true})

	go func() {
		defer func() {
			gitSt.mu.Lock()
			gitSt.loginBusy, gitSt.loginCode, gitSt.loginURL = false, "", ""
			gitSt.mu.Unlock()
		}()
		ctx, cancel := context.WithTimeout(context.Background(), 16*time.Minute)
		defer cancel()
		pub := func(state string, extra map[string]any) {
			ev := map[string]any{"type": "gitlogin", "state": state}
			for k, v := range extra {
				ev[k] = v
			}
			a.events.publish(ev)
		}
		logLine := func(l string) {
			log.Printf("gh: %s", l)
			pub("log", map[string]any{"line": l})
		}
		pub("working", map[string]any{"message": "Preparing GitHub sign-in…"})
		if err := a.ensureGh(ctx, logLine); err != nil {
			pub("error", map[string]any{"message": "Could not install gh: " + err.Error()})
			return
		}
		var code, url string
		err := a.runGuestLines(ctx,
			"gh auth login --hostname github.com --git-protocol https --web --scopes repo,read:org,workflow 2>&1",
			false, "\n\n", func(l string) {
				logLine(l)
				if code == "" {
					if m := deviceCodeRe.FindStringSubmatch(l); m != nil {
						code = m[1]
					}
				}
				if m := deviceURLRe.FindString(l); m != "" {
					url = m
				}
				if code != "" {
					if url == "" {
						url = "https://github.com/login/device"
					}
					gitSt.mu.Lock()
					gitSt.loginCode, gitSt.loginURL = code, url
					gitSt.mu.Unlock()
					pub("code", map[string]any{"code": code, "url": url})
				}
			})
		if err != nil {
			pub("error", map[string]any{"message": "GitHub sign-in did not finish: " + err.Error()})
			return
		}
		// let git use gh's token, and give commits a name and email
		_ = a.runGuestLines(ctx, `gh auth setup-git --hostname github.com 2>&1
u=$(gh api user)
login=$(printf '%s' "$u" | jq -r .login); id=$(printf '%s' "$u" | jq -r .id); name=$(printf '%s' "$u" | jq -r '.name // empty')
[ -n "$(git config --global user.name)" ] || git config --global user.name "${name:-$login}"
[ -n "$(git config --global user.email)" ] || git config --global user.email "${id}+${login}@users.noreply.github.com"
git config --global init.defaultBranch main
git config --global --add safe.directory '*'`, false, "", logLine)
		gitSt.mu.Lock()
		gitSt.repos = nil
		gitSt.mu.Unlock()
		pub("done", nil)
	}()
}

func (a *App) handleGitLogout(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	out, err := a.guestOutput(ctx, "gh auth logout --hostname github.com 2>&1 </dev/null")
	gitSt.mu.Lock()
	gitSt.repos = nil
	gitSt.mu.Unlock()
	if err != nil {
		httpErr(w, fmt.Errorf("%s", strings.TrimSpace(out)), 500)
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}

// handleGitRepos lists the repositories the signed-in user can access:
// their own, collaborations and their organizations', most recent first.
func (a *App) handleGitRepos(w http.ResponseWriter, r *http.Request) {
	gitSt.mu.Lock()
	cached := gitSt.repos
	fresh := time.Since(gitSt.reposAt) < 2*time.Minute
	gitSt.mu.Unlock()
	if cached != nil && fresh && r.URL.Query().Get("refresh") == "" {
		writeJSON(w, cached)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
	defer cancel()
	out, err := a.guestOutput(ctx, `gh api --paginate 'user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member' `+
		`--jq '.[] | {full: .full_name, name: .name, owner: .owner.login, private: .private, fork: .fork, desc: (.description // ""), updated: .pushed_at, branch: .default_branch}' 2>&1`)
	if err != nil {
		httpErr(w, fmt.Errorf("could not list repositories: %s", strings.TrimSpace(out)), 500)
		return
	}
	repos := []map[string]any{}
	for _, l := range strings.Split(out, "\n") {
		var m map[string]any
		if strings.HasPrefix(l, "{") && json.Unmarshal([]byte(l), &m) == nil {
			repos = append(repos, m)
		}
	}
	gitSt.mu.Lock()
	gitSt.repos, gitSt.reposAt = repos, time.Now()
	gitSt.mu.Unlock()
	writeJSON(w, repos)
}

var repoNameRe = regexp.MustCompile(`^[\w.-]+/[\w.-]+$`)

// handleGitClone clones a GitHub repo (owner/name) or any git URL into
// ~/projects and reports progress as "clone" events.
func (a *App) handleGitClone(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Repo string `json:"repo"` // owner/name
		URL  string `json:"url"`  // or any clone URL
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpErr(w, err, 400)
		return
	}
	url := strings.TrimSpace(req.URL)
	if req.Repo != "" {
		if !repoNameRe.MatchString(req.Repo) {
			httpErr(w, errors.New("bad repository name"), 400)
			return
		}
		url = "https://github.com/" + req.Repo + ".git"
	}
	if url == "" || strings.ContainsAny(url, " \n'\"`$;|&") {
		httpErr(w, errors.New("enter a repository URL"), 400)
		return
	}
	name := strings.TrimSuffix(path.Base(strings.TrimRight(url, "/")), ".git")
	if name == "" || name == "." || name == "/" {
		name = "repo"
	}
	root := a.guestProjects()
	dest := root + "/" + name
	if fileExists(a.hostPath(dest + "/.git")) {
		writeJSON(w, map[string]any{"ok": true, "path": dest, "existing": true})
		return
	}
	for i := 2; fileExists(a.hostPath(dest)); i++ {
		dest = fmt.Sprintf("%s/%s-%d", root, name, i)
	}
	gitSt.mu.Lock()
	if gitSt.clones[dest] {
		gitSt.mu.Unlock()
		writeJSON(w, map[string]any{"ok": true, "path": dest, "running": true})
		return
	}
	gitSt.clones[dest] = true
	gitSt.mu.Unlock()
	_ = os.MkdirAll(a.hostPath(root), 0o755)
	writeJSON(w, map[string]any{"ok": true, "path": dest})

	go func() {
		defer func() {
			gitSt.mu.Lock()
			delete(gitSt.clones, dest)
			gitSt.mu.Unlock()
		}()
		pub := func(state string, extra map[string]any) {
			ev := map[string]any{"type": "clone", "state": state, "path": dest, "url": url}
			for k, v := range extra {
				ev[k] = v
			}
			a.events.publish(ev)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
		defer cancel()
		pub("running", map[string]any{"line": "Cloning " + url})
		err := a.runGuestLines(ctx, fmt.Sprintf("git clone --progress %s %s 2>&1", shellQuote(url), shellQuote(dest)), false, "", func(l string) {
			pub("running", map[string]any{"line": l})
		})
		if err != nil {
			pub("error", map[string]any{"message": "git clone failed: " + err.Error()})
			return
		}
		pub("done", nil)
	}()
}
