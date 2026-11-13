package main

import (
	"crypto/subtle"
	"embed"
	"encoding/json"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
)

//go:embed all:dist
var distFS embed.FS

type App struct {
	cfg      *Config
	terms    *TermManager
	chats    *ChatManager
	setup    *Setup
	events   *Hub
	upgrader websocket.Upgrader
}

func newApp(cfg *Config) *App {
	a := &App{cfg: cfg, events: newHub()}
	a.upgrader = websocket.Upgrader{
		ReadBufferSize:  32 << 10,
		WriteBufferSize: 32 << 10,
		CheckOrigin: func(r *http.Request) bool {
			o := r.Header.Get("Origin")
			return o == "" || strings.HasPrefix(o, "http://127.0.0.1:") || strings.HasPrefix(o, "http://localhost:")
		},
	}
	a.setup = newSetup(a)
	a.terms = newTermManager(a)
	a.chats = newChatManager(a)
	return a
}

func (a *App) shutdown() {
	a.terms.closeAll()
	a.chats.closeAll()
}

func (a *App) routes(mux *http.ServeMux) {
	sub, _ := fs.Sub(distFS, "dist")
	static := http.FileServer(http.FS(sub))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		static.ServeHTTP(w, r)
	})
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, map[string]any{"ok": true}) })
	mux.HandleFunc("GET /api/status", a.handleStatus)
	mux.HandleFunc("GET /api/logs", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = w.Write([]byte(serverLog.String()))
	})
	mux.HandleFunc("GET /api/events", a.handleEvents)
	mux.HandleFunc("POST /api/open", a.handleOpen)
	mux.HandleFunc("POST /api/shutdown", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"ok": true})
		go func() {
			time.Sleep(100 * time.Millisecond)
			p, _ := os.FindProcess(os.Getpid())
			_ = p.Signal(syscall.SIGTERM)
		}()
	})

	mux.HandleFunc("POST /api/setup/start", a.setup.handleStart)
	mux.HandleFunc("GET /api/setup/state", a.setup.handleState)

	mux.HandleFunc("GET /api/term/list", a.terms.handleList)
	mux.HandleFunc("POST /api/term/create", a.terms.handleCreate)
	mux.HandleFunc("POST /api/term/close", a.terms.handleClose)
	mux.HandleFunc("GET /api/term/ws", a.terms.handleWS)

	mux.HandleFunc("GET /api/fs/list", a.handleFsList)
	mux.HandleFunc("GET /api/fs/read", a.handleFsRead)
	mux.HandleFunc("POST /api/fs/write", a.handleFsWrite)
	mux.HandleFunc("POST /api/fs/mkdir", a.handleFsMkdir)
	mux.HandleFunc("POST /api/fs/delete", a.handleFsDelete)
	mux.HandleFunc("POST /api/fs/rename", a.handleFsRename)
	mux.HandleFunc("GET /api/fs/find", a.handleFsFind)

	mux.HandleFunc("GET /api/git/status", a.handleGitStatus)
	mux.HandleFunc("POST /api/git/login", a.handleGitLogin)
	mux.HandleFunc("POST /api/git/logout", a.handleGitLogout)
	mux.HandleFunc("GET /api/git/repos", a.handleGitRepos)
	mux.HandleFunc("POST /api/git/clone", a.handleGitClone)

	mux.HandleFunc("POST /api/phone/call", a.handlePhoneCall)

	mux.HandleFunc("GET /api/voice/status", a.handleVoiceStatus)
	mux.HandleFunc("POST /api/voice/install", a.handleVoiceInstall)
	mux.HandleFunc("POST /api/voice/transcribe", a.handleVoiceTranscribe)

	mux.HandleFunc("GET /api/chat/ws", a.chats.handleWS)
	mux.HandleFunc("GET /api/chat/sessions", a.chats.handleSessions)
	mux.HandleFunc("GET /api/chat/history", a.chats.handleHistory)
	mux.HandleFunc("POST /api/internal/approve", a.chats.handleApprove)
}

// auth requires the launch token on every request. The WebView arrives with
// ?t=<token> once; we turn that into an HttpOnly cookie.
func (a *App) auth(next http.Handler) http.Handler {
	want := []byte(a.cfg.Token)
	ok := func(s string) bool { return s != "" && subtle.ConstantTimeCompare([]byte(s), want) == 1 }
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/health" {
			next.ServeHTTP(w, r)
			return
		}
		if t := r.URL.Query().Get("t"); ok(t) {
			http.SetCookie(w, &http.Cookie{Name: "skiff", Value: t, Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode})
			if r.Method == http.MethodGet && !strings.HasPrefix(r.URL.Path, "/api/") {
				q := r.URL.Query()
				q.Del("t")
				target := r.URL.Path
				if len(q) > 0 {
					target += "?" + q.Encode()
				}
				http.Redirect(w, r, target, http.StatusFound)
				return
			}
		} else if c, err := r.Cookie("skiff"); err == nil && ok(c.Value) {
		} else if ok(r.Header.Get("X-Skiff-Token")) {
		} else {
			http.Error(w, "unauthorized: open Skiff from the app", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (a *App) handleStatus(w http.ResponseWriter, r *http.Request) {
	st := a.setup.snapshot()
	home := a.guestHome()
	writeJSON(w, map[string]any{
		"version":  version,
		"android":  a.cfg.Android,
		"arch":     runtime.GOARCH,
		"setup":    st,
		"ready":    a.ready(),
		"home":     home,
		"projects": a.guestProjects(),
		"claude":   a.claudeInstalled(),
		"phone":    a.phoneAvailable(),
	})
}

// ready reports whether terminals and Claude can run: on Android the
// Ubuntu environment must be installed; on a dev machine it always is.
func (a *App) ready() bool {
	if !a.cfg.Android {
		return true
	}
	if fileExists(a.cfg.path("runtime", "setup.done")) {
		return true
	}
	for _, step := range []string{"runtime", "rootfs", "configure"} {
		if !fileExists(a.cfg.path("runtime", "step-"+step+".done")) {
			return false
		}
	}
	return true
}

// setupComplete reports whether every setup step has finished.
func (a *App) setupComplete() bool {
	for _, st := range setupSteps {
		if !fileExists(a.cfg.path("runtime", "step-"+st.ID+".done")) {
			return false
		}
	}
	return true
}

func (a *App) guestHome() string {
	if a.cfg.Android {
		return "/root"
	}
	h, _ := os.UserHomeDir()
	return h
}

func (a *App) guestProjects() string {
	return strings.TrimSuffix(a.guestHome(), "/") + "/projects"
}

func (a *App) claudeInstalled() bool {
	if a.cfg.Android {
		_, err := os.Lstat(a.hostPath("/root/.local/bin/claude"))
		return err == nil
	}
	_, err := exec.LookPath("claude")
	return err == nil
}

func (a *App) handleOpen(w http.ResponseWriter, r *http.Request) {
	var req struct {
		URL string `json:"url"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.URL == "" {
		http.Error(w, "url required", 400)
		return
	}
	log.Printf("open request: %s", req.URL)
	a.events.publish(map[string]any{"type": "open", "url": req.URL})
	writeJSON(w, map[string]any{"ok": true})
}

// ---- event hub: server -> UI notifications (open URL, setup progress) ----

type Hub struct {
	mu   sync.Mutex
	subs map[chan []byte]struct{}
	last map[string][]byte // last event per type, replayed to new subscribers
}

func newHub() *Hub { return &Hub{subs: map[chan []byte]struct{}{}, last: map[string][]byte{}} }

func (h *Hub) publish(ev map[string]any) {
	b, _ := json.Marshal(ev)
	h.mu.Lock()
	defer h.mu.Unlock()
	if t, _ := ev["type"].(string); t == "setup" {
		h.last[t] = b
	}
	for c := range h.subs {
		select {
		case c <- b:
		default:
		}
	}
}

func (a *App) handleEvents(w http.ResponseWriter, r *http.Request) {
	conn, err := a.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()
	c := make(chan []byte, 256)
	a.events.mu.Lock()
	a.events.subs[c] = struct{}{}
	for _, b := range a.events.last {
		c <- b
	}
	a.events.mu.Unlock()
	defer func() {
		a.events.mu.Lock()
		delete(a.events.subs, c)
		a.events.mu.Unlock()
	}()
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}()
	ping := time.NewTicker(25 * time.Second)
	defer ping.Stop()
	for {
		select {
		case b := <-c:
			if conn.WriteMessage(websocket.TextMessage, b) != nil {
				return
			}
		case <-ping.C:
			if conn.WriteMessage(websocket.PingMessage, nil) != nil {
				return
			}
		case <-done:
			return
		}
	}
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func httpErr(w http.ResponseWriter, err error, code int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": err.Error()})
}
