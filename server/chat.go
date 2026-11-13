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
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
)

// ChatSession drives one Claude Code process in headless stream-json mode
// (claude -p --input-format stream-json --output-format stream-json) and
// relays its events to the chat UI. Permission prompts arrive through the
// skiff MCP server (skiffd mcp-approve), configured as Claude Code's
// --permission-prompt-tool.
type ChatSession struct {
	ID string
	m  *ChatManager

	mu        sync.Mutex
	startMu   sync.Mutex
	cwd       string
	mode      string // default | acceptEdits | plan | bypassPermissions
	model     string
	sessionID string
	cmd       *exec.Cmd
	stdin     io.WriteCloser
	busy      bool
	log       [][]byte
	subs      map[*websocket.Conn]chan []byte
	pending   map[string]chan approval
	always    map[string]bool
	reqSeq    int

	assist         bool              // opened from the side-button assistant: short spoken answers
	content        bool              // this backend has shown conversation content
	stopping       bool              // we asked the process to exit
	restartPending bool              // restart (new cwd/resume) once idle
	controls       map[string]string // in-flight control requests: id -> subtype
}

type approval struct {
	Allow        bool            `json:"allow"`
	Always       bool            `json:"always"`
	Message      string          `json:"message"`
	UpdatedInput json.RawMessage `json:"updatedInput"`
}

type ChatManager struct {
	app    *App
	mu     sync.Mutex
	list   map[string]*ChatSession
	saveMu sync.Mutex
	saved  map[string]savedChat
}

// savedChat is what survives a backend restart or app upgrade: which
// Claude Code session a chat tab shows. The conversation itself lives in
// Claude Code's own transcript files.
type savedChat struct {
	SessionID string `json:"sessionId"`
	Cwd       string `json:"cwd"`
	Mode      string `json:"mode"`
	Model     string `json:"model"`
	Updated   int64  `json:"updated"`
}

func newChatManager(a *App) *ChatManager {
	m := &ChatManager{app: a, list: map[string]*ChatSession{}, saved: map[string]savedChat{}}
	if b, err := os.ReadFile(m.statePath()); err == nil {
		_ = json.Unmarshal(b, &m.saved)
	}
	return m
}

func (m *ChatManager) statePath() string { return m.app.cfg.path("state", "chats.json") }

// remember records a chat's session; called with s.mu held.
func (m *ChatManager) remember(s *ChatSession) {
	if s.sessionID == "" {
		return
	}
	m.saveMu.Lock()
	defer m.saveMu.Unlock()
	m.saved[s.ID] = savedChat{SessionID: s.sessionID, Cwd: s.cwd, Mode: s.mode, Model: s.model, Updated: time.Now().Unix()}
	if len(m.saved) > 200 { // keep the most recent
		type kv struct {
			k string
			t int64
		}
		var all []kv
		for k, v := range m.saved {
			all = append(all, kv{k, v.Updated})
		}
		sort.Slice(all, func(i, j int) bool { return all[i].t > all[j].t })
		for _, x := range all[200:] {
			delete(m.saved, x.k)
		}
	}
	b, _ := json.Marshal(m.saved)
	_ = os.MkdirAll(filepath.Dir(m.statePath()), 0o755)
	tmp := m.statePath() + ".tmp"
	if os.WriteFile(tmp, b, 0o600) == nil {
		_ = os.Rename(tmp, m.statePath())
	}
}

func (m *ChatManager) get(id string, create bool) *ChatSession {
	m.mu.Lock()
	defer m.mu.Unlock()
	s := m.list[id]
	if s == nil && create {
		s = &ChatSession{ID: id, m: m, mode: "default", cwd: m.app.guestProjects(),
			subs: map[*websocket.Conn]chan []byte{}, pending: map[string]chan approval{}, always: map[string]bool{},
			controls: map[string]string{}}
		m.saveMu.Lock()
		if sv, ok := m.saved[id]; ok {
			s.sessionID, s.cwd, s.mode, s.model = sv.SessionID, sv.Cwd, sv.Mode, sv.Model
			if s.mode == "" {
				s.mode = "default"
			}
		}
		m.saveMu.Unlock()
		m.list[id] = s
	}
	return s
}

func (m *ChatManager) closeAll() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, s := range m.list {
		s.stop()
	}
}

// emit sends a message to every attached UI and records it for replay.
func (s *ChatSession) emit(v map[string]any) {
	b, _ := json.Marshal(v)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.emitLocked(b)
}

func (s *ChatSession) emitLocked(b []byte) {
	s.log = append(s.log, b)
	if len(s.log) > 6000 {
		s.log = s.log[len(s.log)-6000:]
	}
	for _, c := range s.subs {
		select {
		case c <- b:
		default:
		}
	}
}

// statusLocked tells attached UIs the current state. Status is not kept in
// the replay log: every new connection gets a fresh one.
func (s *ChatSession) statusLocked() {
	b, _ := json.Marshal(map[string]any{"t": "status", "busy": s.busy, "running": s.cmd != nil,
		"sessionId": s.sessionID, "mode": s.mode, "model": s.model, "cwd": s.cwd})
	for _, c := range s.subs {
		select {
		case c <- b:
		default:
		}
	}
}

func (m *ChatManager) handleWS(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	if id == "" {
		http.Error(w, "id required", 400)
		return
	}
	s := m.get(id, true)
	conn, err := m.app.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()
	out := make(chan []byte, 4096)
	s.mu.Lock()
	replay := append([][]byte(nil), s.log...)
	s.subs[conn] = out
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.subs, conn)
		s.mu.Unlock()
	}()
	_ = conn.WriteMessage(websocket.TextMessage, []byte(`{"t":"replay_start"}`))
	for _, b := range replay {
		if conn.WriteMessage(websocket.TextMessage, b) != nil {
			return
		}
	}
	_ = conn.WriteMessage(websocket.TextMessage, []byte(`{"t":"replay_end"}`))
	s.mu.Lock()
	if !s.content && s.sessionID != "" {
		// the backend restarted (or the app was upgraded): let the UI reload
		// this conversation from Claude Code's transcript
		b, _ := json.Marshal(map[string]any{"t": "restore", "sessionId": s.sessionID, "cwd": s.cwd})
		_ = conn.WriteMessage(websocket.TextMessage, b)
	}
	s.statusLocked()
	s.mu.Unlock()

	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			_, data, err := conn.ReadMessage()
			if err != nil {
				return
			}
			s.handleClient(data)
		}
	}()
	ping := time.NewTicker(25 * time.Second)
	defer ping.Stop()
	for {
		select {
		case b := <-out:
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

func (s *ChatSession) handleClient(data []byte) {
	var msg struct {
		T       string          `json:"t"`
		Cwd     string          `json:"cwd"`
		Mode    string          `json:"mode"`
		Model   string          `json:"model"`
		Resume  *string         `json:"resume"`
		Assist  bool            `json:"assist"`
		Content json.RawMessage `json:"content"`
		ID      string          `json:"id"`
		approval
	}
	if err := json.Unmarshal(data, &msg); err != nil {
		return
	}
	switch msg.T {
	case "config":
		if msg.Assist {
			s.mu.Lock()
			s.assist = true
			s.mu.Unlock()
		}
		s.configure(msg.Cwd, msg.Mode, msg.Model, msg.Resume)
	case "warm":
		// start Claude Code while the user is still talking, so the reply comes sooner
		s.mu.Lock()
		running := s.cmd != nil
		s.mu.Unlock()
		if !running {
			go func() {
				if err := s.start(); err != nil {
					log.Printf("chat %s: warm start: %v", s.ID, err)
				}
			}()
		}
	case "send":
		if err := s.send(msg.Content); err != nil {
			s.emit(map[string]any{"t": "error", "message": err.Error()})
		}
	case "interrupt":
		s.interrupt()
	case "stop":
		s.stop()
	case "approve":
		s.mu.Lock()
		ch := s.pending[msg.ID]
		s.mu.Unlock()
		if ch != nil {
			select {
			case ch <- msg.approval:
			default:
			}
		}
	}
}

func (s *ChatSession) configure(cwd, mode, model string, resume *string) {
	log.Printf("chat %s: config cwd=%q mode=%q model=%q resume=%v", s.ID, cwd, mode, model, resume != nil)
	s.mu.Lock()
	restart := false
	if cwd != "" && cwd != s.cwd {
		s.cwd, restart = cwd, true
		if resume == nil {
			s.sessionID = ""
		}
	}
	if resume != nil && *resume != s.sessionID {
		s.sessionID, restart = *resume, true
	}
	running := s.cmd != nil && s.stdin != nil
	if mode != "" && mode != s.mode {
		s.mode = mode
		if running && !restart {
			s.controlLocked("set_permission_mode", map[string]any{"mode": mode})
		}
	}
	if model != s.model {
		s.model = model
		if running && !restart {
			var mv any = model
			if model == "" {
				mv = nil
			}
			s.controlLocked("set_model", map[string]any{"model": mv})
		}
	}
	busy := s.busy
	if restart && running && busy {
		s.restartPending = true // after this turn
	}
	s.m.remember(s)
	s.statusLocked()
	s.mu.Unlock()
	if restart && running && !busy {
		s.stop() // the next message starts a fresh process (with --resume when continuing)
	}
}

// controlLocked sends a control request to the running Claude Code process
// (the same protocol the Agent SDK uses). Called with s.mu held.
func (s *ChatSession) controlLocked(subtype string, fields map[string]any) string {
	if s.stdin == nil {
		return ""
	}
	s.reqSeq++
	id := fmt.Sprintf("skiff-%d", s.reqSeq)
	req := map[string]any{"subtype": subtype}
	for k, v := range fields {
		req[k] = v
	}
	b, _ := json.Marshal(map[string]any{"type": "control_request", "request_id": id, "request": req})
	if _, err := s.stdin.Write(append(b, '\n')); err != nil {
		return ""
	}
	s.controls[id] = subtype
	return id
}

func (s *ChatSession) mcpConfigPath() (string, error) {
	a := s.m.app
	guest := a.guestHome() + "/.skiff/mcp.json"
	self := a.cfg.Self
	if a.cfg.Android {
		self = "/opt/skiff/libskiffd.so"
	}
	env := map[string]string{"SKIFF_URL": fmt.Sprintf("http://127.0.0.1:%d", a.cfg.Port), "SKIFF_TOKEN": a.cfg.Token}
	servers := map[string]any{"skiff": map[string]any{"type": "stdio", "command": self, "args": []string{"mcp-approve"}, "env": env}}
	if a.phoneAvailable() {
		servers["phone"] = map[string]any{"type": "stdio", "command": self, "args": []string{"mcp-phone"}, "env": env}
	}
	cfg := map[string]any{"mcpServers": servers}
	b, _ := json.MarshalIndent(cfg, "", "  ")
	hp := a.hostPath(guest)
	if err := os.MkdirAll(filepath.Dir(hp), 0o700); err != nil {
		return "", err
	}
	return guest, os.WriteFile(hp, b, 0o600)
}

// assistPrompt shapes replies for the side-button assistant, where the
// answer is read aloud.
const assistPrompt = `You are the phone's voice assistant: the user opened you with the side button and is talking to you; your reply is read aloud.
Answer in one to three short, natural spoken sentences unless they ask for detail. No markdown, headings, tables, bullet lists or code unless asked.
When they ask you to do something on the phone, do it with the phone tools rather than explaining how, then confirm in a few words.
If you need something from them, ask one short question.`

func (s *ChatSession) start() error {
	// one start at a time: a warm start and the first message can race
	s.startMu.Lock()
	defer s.startMu.Unlock()
	s.mu.Lock()
	already := s.cmd != nil
	s.mu.Unlock()
	if already {
		return nil
	}
	a := s.m.app
	if !a.ready() {
		return errors.New("finish Setup first: the Linux environment is not installed")
	}
	if !a.claudeInstalled() {
		return errors.New("Claude Code is not installed: run Setup → Reinstall Claude Code")
	}
	mcp, err := s.mcpConfigPath()
	if err != nil {
		return err
	}
	s.mu.Lock()
	args := []string{"claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json",
		"--verbose", "--include-partial-messages",
		"--permission-mode", s.mode,
		"--mcp-config", mcp, "--permission-prompt-tool", "mcp__skiff__approve"}
	if a.phoneAvailable() {
		// phone actions are confirmed on the phone itself (risky ones ask there)
		args = append(args, "--allowedTools", "mcp__phone")
	}
	if s.model != "" {
		args = append(args, "--model", s.model)
	}
	if s.assist {
		args = append(args, "--append-system-prompt", assistPrompt)
	}
	if s.sessionID != "" {
		args = append(args, "--resume", s.sessionID)
	}
	cwd := s.cwd
	s.mu.Unlock()
	_ = os.MkdirAll(a.hostPath(cwd), 0o755)
	cmd, err := a.guestCommand(args, cwd, map[string]string{"SKIFF_CHAT": s.ID, "SKIFF_USER": "1"})
	if err != nil {
		return err
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start claude: %w", err)
	}
	log.Printf("chat %s: started claude pid=%d cwd=%s mode=%s resume=%s", s.ID, cmd.Process.Pid, cwd, s.mode, s.sessionID)
	s.mu.Lock()
	s.cmd, s.stdin = cmd, stdin
	s.statusLocked()
	s.mu.Unlock()

	go func() {
		sc := bufio.NewScanner(stderr)
		sc.Buffer(make([]byte, 64<<10), 4<<20)
		for sc.Scan() {
			line := sc.Text()
			if strings.HasPrefix(line, "proot warning:") {
				continue
			}
			log.Printf("chat %s stderr: %s", s.ID, line)
			s.emit(map[string]any{"t": "stderr", "line": line})
		}
	}()
	go func() {
		sc := bufio.NewScanner(stdout)
		sc.Buffer(make([]byte, 256<<10), 64<<20)
		for sc.Scan() {
			line := sc.Bytes()
			if len(line) == 0 || line[0] != '{' {
				continue
			}
			s.onEvent(append([]byte(nil), line...))
		}
		err := cmd.Wait()
		code := 0
		if ee, ok := err.(*exec.ExitError); ok {
			code = ee.ExitCode()
		}
		log.Printf("chat %s: claude exited code=%d", s.ID, code)
		s.mu.Lock()
		expected := s.stopping
		wasBusy := s.busy
		if s.cmd == cmd {
			s.cmd, s.stdin, s.busy, s.stopping = nil, nil, false, false
			s.controls = map[string]string{}
		}
		for id, ch := range s.pending {
			close(ch)
			delete(s.pending, id)
		}
		b, _ := json.Marshal(map[string]any{"t": "exit", "code": code, "expected": expected, "wasBusy": wasBusy})
		s.emitLocked(b)
		s.statusLocked()
		s.mu.Unlock()
	}()
	return nil
}

func (s *ChatSession) onEvent(line []byte) {
	var head struct {
		Type      string `json:"type"`
		Subtype   string `json:"subtype"`
		SessionID string `json:"session_id"`
		Response  struct {
			Subtype   string `json:"subtype"`
			RequestID string `json:"request_id"`
			Error     string `json:"error"`
		} `json:"response"`
	}
	_ = json.Unmarshal(line, &head)
	s.mu.Lock()
	defer s.mu.Unlock()
	if head.Type == "control_response" {
		kind := s.controls[head.Response.RequestID]
		delete(s.controls, head.Response.RequestID)
		if head.Response.Subtype == "error" {
			log.Printf("chat %s: control %s failed: %s", s.ID, kind, head.Response.Error)
			if kind == "set_permission_mode" || kind == "set_model" {
				s.restartPending = true // apply on a fresh process after this turn
				if !s.busy {
					go s.stop()
				}
			}
		}
		if kind == "interrupt" {
			s.busy = false
			s.statusLocked()
		}
		return
	}
	if head.SessionID != "" && head.SessionID != s.sessionID {
		s.sessionID = head.SessionID
		s.m.remember(s)
		s.statusLocked()
	}
	if head.Type == "stream_event" {
		// partial deltas are relayed but not kept for replay
		b := append([]byte(`{"t":"ev","ev":`), line...)
		b = append(b, '}')
		for _, c := range s.subs {
			select {
			case c <- b:
			default:
			}
		}
		return
	}
	b := append([]byte(`{"t":"ev","ev":`), line...)
	b = append(b, '}')
	s.emitLocked(b)
	if head.Type == "assistant" || head.Type == "user" || head.Type == "result" {
		s.content = true
	}
	if head.Type == "result" {
		s.busy = false
		s.m.remember(s)
		s.statusLocked()
		if s.restartPending {
			s.restartPending = false
			go s.stop()
		}
	}
}

func (s *ChatSession) send(content json.RawMessage) error {
	s.mu.Lock()
	running := s.cmd != nil
	s.mu.Unlock()
	if !running {
		if err := s.start(); err != nil {
			return err
		}
	}
	msg := map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": content}}
	b, _ := json.Marshal(msg)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stdin == nil {
		return errors.New("claude is not running")
	}
	if _, err := s.stdin.Write(append(b, '\n')); err != nil {
		return err
	}
	s.busy = true
	if !s.content && s.sessionID != "" {
		// first message after a restore: the UI already shows the transcript
		s.content = true
	}
	ub, _ := json.Marshal(map[string]any{"t": "user", "content": content, "ts": time.Now().UnixMilli()})
	s.emitLocked(ub)
	s.statusLocked()
	return nil
}

func (s *ChatSession) interrupt() {
	s.mu.Lock()
	if s.stdin == nil {
		s.mu.Unlock()
		return
	}
	s.controlLocked("interrupt", nil)
	b, _ := json.Marshal(map[string]any{"t": "interrupted"})
	s.emitLocked(b)
	s.mu.Unlock()
	go func() {
		time.Sleep(5 * time.Second)
		s.mu.Lock()
		busy := s.busy
		s.mu.Unlock()
		if busy {
			log.Printf("chat %s: interrupt not acknowledged, stopping process", s.ID)
			s.stop()
		}
	}()
}

func (s *ChatSession) stop() {
	s.mu.Lock()
	if s.cmd != nil {
		s.stopping = true
	}
	cmd := s.cmd
	stdin := s.stdin
	s.mu.Unlock()
	if stdin != nil {
		_ = stdin.Close()
	}
	if cmd != nil && cmd.Process != nil {
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM)
		go func() {
			time.Sleep(2 * time.Second)
			_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		}()
	}
}

// handleApprove is called by the MCP permission server running inside the
// Linux environment. It blocks until the user answers in the chat UI.
func (m *ChatManager) handleApprove(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Chat      string          `json:"chat"`
		ToolName  string          `json:"tool_name"`
		Input     json.RawMessage `json:"input"`
		ToolUseID string          `json:"tool_use_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpErr(w, err, 400)
		return
	}
	s := m.get(req.Chat, false)
	deny := func(msg string) {
		writeJSON(w, map[string]any{"behavior": "deny", "message": msg})
	}
	if s == nil {
		deny("no Skiff chat is attached to this session")
		return
	}
	allow := func(input json.RawMessage) {
		if len(input) == 0 || string(input) == "null" {
			input = req.Input
		}
		writeJSON(w, map[string]any{"behavior": "allow", "updatedInput": input})
	}
	// questions and plan approvals always need a real answer from the user
	interactive := req.ToolName == "AskUserQuestion" || req.ToolName == "ExitPlanMode"
	s.mu.Lock()
	if s.always[req.ToolName] && !interactive {
		s.mu.Unlock()
		allow(nil)
		return
	}
	s.reqSeq++
	id := fmt.Sprintf("p%d", s.reqSeq)
	ch := make(chan approval, 1)
	s.pending[id] = ch
	b, _ := json.Marshal(map[string]any{"t": "approval", "id": id, "tool": req.ToolName, "input": req.Input, "toolUseId": req.ToolUseID})
	s.emitLocked(b)
	s.mu.Unlock()

	var dec approval
	var ok bool
	select {
	case dec, ok = <-ch:
	case <-r.Context().Done():
	}
	s.mu.Lock()
	delete(s.pending, id)
	if ok && dec.Allow && dec.Always && !interactive {
		s.always[req.ToolName] = true
	}
	done := map[string]any{"t": "approval_done", "id": id, "allow": ok && dec.Allow, "always": ok && dec.Always && !interactive}
	if ok && dec.Allow && len(dec.UpdatedInput) > 0 {
		var ui struct {
			Answers json.RawMessage `json:"answers"`
		}
		if json.Unmarshal(dec.UpdatedInput, &ui) == nil && len(ui.Answers) > 0 {
			done["answers"] = ui.Answers
		}
	}
	b, _ = json.Marshal(done)
	s.emitLocked(b)
	s.mu.Unlock()
	if ok && dec.Allow {
		allow(dec.UpdatedInput)
		return
	}
	msg := "The user denied this action."
	if dec.Message != "" {
		msg += " They said: " + dec.Message
	}
	deny(msg)
}

// ---- past sessions, read from Claude Code's own transcripts ----

var nonAlnum = regexp.MustCompile(`[^a-zA-Z0-9]`)

func (m *ChatManager) transcriptDir(cwd string) string {
	return m.app.hostPath(m.app.guestHome() + "/.claude/projects/" + nonAlnum.ReplaceAllString(cwd, "-"))
}

type sessionInfo struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	Cwd   string `json:"cwd"`
	Mtime int64  `json:"mtime"`
	Size  int64  `json:"size"`
}

// handleSessions lists past Claude Code conversations, for one project
// (?cwd=) or across all projects (?all=1), newest first.
func (m *ChatManager) handleSessions(w http.ResponseWriter, r *http.Request) {
	var dirs []string
	if r.URL.Query().Get("all") == "1" {
		root := m.app.hostPath(m.app.guestHome() + "/.claude/projects")
		ents, _ := os.ReadDir(root)
		for _, e := range ents {
			if e.IsDir() {
				dirs = append(dirs, filepath.Join(root, e.Name()))
			}
		}
	} else {
		dirs = []string{m.transcriptDir(r.URL.Query().Get("cwd"))}
	}
	type file struct {
		path string
		info os.FileInfo
	}
	var files []file
	for _, dir := range dirs {
		ents, _ := os.ReadDir(dir)
		for _, e := range ents {
			if !strings.HasSuffix(e.Name(), ".jsonl") {
				continue
			}
			if info, err := e.Info(); err == nil && info.Size() > 0 {
				files = append(files, file{filepath.Join(dir, e.Name()), info})
			}
		}
	}
	sort.Slice(files, func(i, j int) bool { return files[i].info.ModTime().After(files[j].info.ModTime()) })
	if len(files) > 60 {
		files = files[:60]
	}
	out := []sessionInfo{}
	for _, f := range files {
		title, cwd := transcriptInfo(f.path)
		if title == "" && cwd == "" {
			continue
		}
		out = append(out, sessionInfo{ID: strings.TrimSuffix(filepath.Base(f.path), ".jsonl"), Title: title, Cwd: cwd,
			Mtime: f.info.ModTime().Unix(), Size: f.info.Size()})
	}
	writeJSON(w, out)
}

// transcriptInfo reads a title (summary or first prompt) and the working
// directory from a Claude Code transcript.
func transcriptInfo(path string) (title, cwd string) {
	f, err := os.Open(path)
	if err != nil {
		return "", ""
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64<<10), 16<<20)
	summary := ""
	for i := 0; sc.Scan() && i < 400; i++ {
		var e struct {
			Type    string `json:"type"`
			Summary string `json:"summary"`
			Cwd     string `json:"cwd"`
			IsMeta  bool   `json:"isMeta"`
			Message struct {
				Content json.RawMessage `json:"content"`
			} `json:"message"`
		}
		if json.Unmarshal(sc.Bytes(), &e) != nil {
			continue
		}
		if cwd == "" && e.Cwd != "" {
			cwd = e.Cwd
		}
		if e.Type == "summary" && e.Summary != "" && summary == "" {
			summary = e.Summary
		}
		if title == "" && e.Type == "user" && !e.IsMeta {
			if t := firstText(e.Message.Content); t != "" && !strings.HasPrefix(t, "<") {
				if len([]rune(t)) > 120 {
					t = string([]rune(t)[:120]) + "…"
				}
				title = t
			}
		}
		if title != "" && cwd != "" && summary != "" {
			break
		}
	}
	if summary != "" {
		title = summary
	}
	return title, cwd
}

func firstText(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return strings.TrimSpace(s)
	}
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &blocks) == nil {
		for _, b := range blocks {
			if b.Type == "text" && strings.TrimSpace(b.Text) != "" {
				return strings.TrimSpace(b.Text)
			}
		}
	}
	return ""
}

// handleHistory returns a transcript's user and assistant messages so the
// UI can show a resumed conversation.
func (m *ChatManager) handleHistory(w http.ResponseWriter, r *http.Request) {
	id := filepath.Base(r.URL.Query().Get("id"))
	f, err := os.Open(filepath.Join(m.transcriptDir(r.URL.Query().Get("cwd")), id+".jsonl"))
	if err != nil {
		httpErr(w, err, 404)
		return
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64<<10), 64<<20)
	out := []json.RawMessage{}
	for sc.Scan() {
		var e struct {
			Type        string `json:"type"`
			IsSidechain bool   `json:"isSidechain"`
			IsMeta      bool   `json:"isMeta"`
		}
		if json.Unmarshal(sc.Bytes(), &e) != nil || e.IsSidechain || e.IsMeta {
			continue
		}
		if e.Type == "user" || e.Type == "assistant" {
			out = append(out, append(json.RawMessage(nil), sc.Bytes()...))
		}
	}
	if len(out) > 1500 {
		out = out[len(out)-1500:]
	}
	writeJSON(w, out)
}

var _ = context.Background
