package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"
	"github.com/gorilla/websocket"
)

const scrollbackBytes = 512 << 10

type TermSession struct {
	ID       string    `json:"id"`
	Title    string    `json:"title"`
	Kind     string    `json:"kind"`
	Cwd      string    `json:"cwd"`
	Created  time.Time `json:"created"`
	Exited   bool      `json:"exited"`
	ExitCode int       `json:"exitCode"`

	mu   sync.Mutex
	cmd  *exec.Cmd
	ptmx *os.File
	buf  []byte
	subs map[*websocket.Conn]chan []byte
}

type TermManager struct {
	app  *App
	mu   sync.Mutex
	seq  int
	list map[string]*TermSession
}

func newTermManager(a *App) *TermManager {
	return &TermManager{app: a, list: map[string]*TermSession{}}
}

func (m *TermManager) handleList(w http.ResponseWriter, r *http.Request) {
	m.mu.Lock()
	out := make([]*TermSession, 0, len(m.list))
	for _, s := range m.list {
		out = append(out, s)
	}
	m.mu.Unlock()
	sort.Slice(out, func(i, j int) bool { return out[i].Created.Before(out[j].Created) })
	writeJSON(w, out)
}

type createReq struct {
	Kind  string `json:"kind"` // shell | claude | android
	Cwd   string `json:"cwd"`  // guest path
	Cols  int    `json:"cols"`
	Rows  int    `json:"rows"`
	Title string `json:"title"`
	Args  string `json:"args"` // extra args for claude
	Cmd   string `json:"cmd"`  // optional command to run in a shell
}

func (m *TermManager) handleCreate(w http.ResponseWriter, r *http.Request) {
	var req createReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpErr(w, err, 400)
		return
	}
	s, err := m.create(req)
	if err != nil {
		log.Printf("term create: %v", err)
		httpErr(w, err, 500)
		return
	}
	writeJSON(w, s)
}

func (m *TermManager) create(req createReq) (*TermSession, error) {
	a := m.app
	if req.Cols <= 0 {
		req.Cols = 80
	}
	if req.Rows <= 0 {
		req.Rows = 24
	}
	if req.Cwd == "" {
		req.Cwd = a.guestHome()
	}
	if req.Kind != "android" && !a.ready() {
		return nil, fmt.Errorf("the Linux environment is not installed yet: open Setup first")
	}
	shell := "/bin/bash"
	if !a.cfg.Android {
		if s := os.Getenv("SHELL"); s != "" {
			shell = s
		}
	}
	var cmd *exec.Cmd
	var err error
	title := req.Title
	switch req.Kind {
	case "android":
		sh := "/system/bin/sh"
		if _, e := os.Stat(sh); e != nil {
			sh = "/bin/sh"
		}
		cmd = exec.Command(sh)
		cmd.Env = append(os.Environ(), "TERM=xterm-256color", "HOME="+a.cfg.Home)
		cmd.Dir = a.cfg.Home
		if title == "" {
			title = "android"
		}
	case "claude":
		line := "claude"
		if req.Args != "" {
			line += " " + req.Args
		}
		script := line + "; code=$?; printf '\\n\\033[2m[claude exited (%s). This tab is a normal shell now.]\\033[0m\\n' \"$code\"; exec " + shell + " -l"
		cmd, err = a.guestCommand([]string{shell, "-lc", script}, req.Cwd, map[string]string{"SKIFF_USER": "1"})
		if title == "" {
			title = "claude"
		}
	default:
		argv := []string{shell, "-l"}
		if req.Cmd != "" {
			argv = []string{shell, "-lc", req.Cmd + "; exec " + shell + " -l"}
		}
		cmd, err = a.guestCommand(argv, req.Cwd, nil)
		if title == "" {
			title = "bash"
		}
		req.Kind = "shell"
	}
	if err != nil {
		return nil, err
	}
	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: uint16(req.Cols), Rows: uint16(req.Rows)})
	if err != nil {
		return nil, fmt.Errorf("start terminal: %w", err)
	}
	m.mu.Lock()
	m.seq++
	s := &TermSession{
		ID: fmt.Sprintf("t%d", m.seq), Title: title, Kind: req.Kind, Cwd: req.Cwd, Created: time.Now(),
		cmd: cmd, ptmx: ptmx, subs: map[*websocket.Conn]chan []byte{},
	}
	m.list[s.ID] = s
	m.mu.Unlock()
	log.Printf("term %s started: kind=%s cwd=%s pid=%d", s.ID, s.Kind, s.Cwd, cmd.Process.Pid)

	go s.pump()
	return s, nil
}

func (s *TermSession) pump() {
	b := make([]byte, 32<<10)
	for {
		n, err := s.ptmx.Read(b)
		if n > 0 {
			chunk := append([]byte(nil), b[:n]...)
			s.mu.Lock()
			s.buf = append(s.buf, chunk...)
			if len(s.buf) > scrollbackBytes {
				s.buf = append([]byte(nil), s.buf[len(s.buf)-scrollbackBytes:]...)
			}
			for _, c := range s.subs {
				select {
				case c <- chunk:
				default:
				}
			}
			s.mu.Unlock()
		}
		if err != nil {
			break
		}
	}
	err := s.cmd.Wait()
	code := 0
	if ee, ok := err.(*exec.ExitError); ok {
		code = ee.ExitCode()
	}
	s.mu.Lock()
	s.Exited, s.ExitCode = true, code
	msg, _ := json.Marshal(map[string]any{"t": "exit", "code": code})
	for _, c := range s.subs {
		select {
		case c <- append([]byte{0}, msg...):
		default:
		}
	}
	s.mu.Unlock()
	log.Printf("term %s exited: code=%d", s.ID, code)
}

func (s *TermSession) kill() {
	if s.cmd != nil && s.cmd.Process != nil {
		_ = syscall.Kill(-s.cmd.Process.Pid, syscall.SIGHUP)
		_ = s.cmd.Process.Kill()
	}
	_ = s.ptmx.Close()
}

func (m *TermManager) handleClose(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID string `json:"id"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	m.mu.Lock()
	s := m.list[req.ID]
	delete(m.list, req.ID)
	m.mu.Unlock()
	if s != nil {
		s.kill()
	}
	writeJSON(w, map[string]any{"ok": true})
}

func (m *TermManager) closeAll() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, s := range m.list {
		s.kill()
		delete(m.list, id)
	}
}

// handleWS attaches a WebSocket to a terminal session. Output goes to the
// client as binary frames (a frame starting with 0x00 carries JSON control
// data); the client sends JSON: {"t":"i","d":input} or {"t":"r","c":cols,"r":rows}.
func (m *TermManager) handleWS(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	m.mu.Lock()
	s := m.list[id]
	m.mu.Unlock()
	if s == nil {
		http.Error(w, "no such terminal", 404)
		return
	}
	conn, err := m.app.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()
	out := make(chan []byte, 1024)
	s.mu.Lock()
	initial := append([]byte(nil), s.buf...)
	exited := s.Exited
	s.subs[conn] = out
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.subs, conn)
		s.mu.Unlock()
	}()
	if len(initial) > 0 {
		_ = conn.WriteMessage(websocket.BinaryMessage, initial)
	}
	if exited {
		msg, _ := json.Marshal(map[string]any{"t": "exit", "code": s.ExitCode})
		_ = conn.WriteMessage(websocket.BinaryMessage, append([]byte{0}, msg...))
	}

	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			_, data, err := conn.ReadMessage()
			if err != nil {
				return
			}
			var msg struct {
				T    string `json:"t"`
				D    string `json:"d"`
				Cols int    `json:"c"`
				Rows int    `json:"r"`
			}
			if json.Unmarshal(data, &msg) != nil {
				continue
			}
			switch msg.T {
			case "i":
				_, _ = s.ptmx.Write([]byte(msg.D))
			case "r":
				if msg.Cols > 0 && msg.Rows > 0 {
					_ = pty.Setsize(s.ptmx, &pty.Winsize{Cols: uint16(msg.Cols), Rows: uint16(msg.Rows)})
				}
			}
		}
	}()
	ping := time.NewTicker(25 * time.Second)
	defer ping.Stop()
	for {
		select {
		case b := <-out:
			// coalesce queued chunks into one frame
			for more := true; more && len(b) < 256<<10; {
				select {
				case c := <-out:
					if len(c) > 0 && c[0] == 0 {
						_ = conn.WriteMessage(websocket.BinaryMessage, b)
						b = c
						more = false
					} else {
						b = append(b, c...)
					}
				default:
					more = false
				}
			}
			if conn.WriteMessage(websocket.BinaryMessage, b) != nil {
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

// shellQuote quotes s for a POSIX shell.
func shellQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }
