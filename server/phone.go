package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Phone control: Claude Code reaches the phone through an MCP server
// ("phone", run as `skiffd mcp-phone` inside Ubuntu) → skiffd
// /api/phone/call → the app's local phone server → Accessibility and
// Android intents. Confirmation of risky actions happens on the phone.

type phoneTool struct {
	Name, Desc string
	Props      map[string]any
	Required   []string
	ReadOnly   bool
}

func num(desc string) map[string]any   { return map[string]any{"type": "integer", "description": desc} }
func str(desc string) map[string]any   { return map[string]any{"type": "string", "description": desc} }
func boolp(desc string) map[string]any { return map[string]any{"type": "boolean", "description": desc} }
func enum(desc string, v ...string) map[string]any {
	return map[string]any{"type": "string", "description": desc, "enum": v}
}

var phoneTools = []phoneTool{
	{Name: "read_screen", ReadOnly: true, Desc: "Read what is on the phone screen now: the app in front and a numbered list of elements (buttons, text, fields, lists) with ids, states and centre coordinates. Call this before tapping or typing, and again whenever the screen may have changed."},
	{Name: "screenshot", ReadOnly: true, Desc: "Take a screenshot of the phone screen (as an image). Use when read_screen is not enough, for example images, maps, games or canvases."},
	{Name: "tap", Desc: "Tap an element by id (from read_screen), by visible text, or at x,y coordinates. Returns the screen after the tap.",
		Props: map[string]any{"id": num("Element id from read_screen"), "text": str("Visible text or label to tap"), "x": num("X coordinate"), "y": num("Y coordinate")}},
	{Name: "long_press", Desc: "Long-press an element by id, text, or x,y. Returns the screen afterwards.",
		Props: map[string]any{"id": num("Element id"), "text": str("Visible text"), "x": num("X"), "y": num("Y")}},
	{Name: "type", Desc: "Type text into a field (by id, or the focused field). Replaces the field's text unless append is true. submit presses the keyboard's enter/send action.",
		Props: map[string]any{"text": str("Text to type"), "id": num("Field id from read_screen"), "append": boolp("Add to the existing text"), "submit": boolp("Press enter afterwards")}, Required: []string{"text"}},
	{Name: "scroll", Desc: "Scroll the main list (or the list with the given id) in a direction.",
		Props: map[string]any{"direction": enum("Direction to move the content", "down", "up", "left", "right"), "id": num("Scrollable element id")}, Required: []string{"direction"}},
	{Name: "swipe", Desc: "Swipe from (x1,y1) to (x2,y2).",
		Props: map[string]any{"x1": num(""), "y1": num(""), "x2": num(""), "y2": num(""), "ms": num("Duration in milliseconds (default 300)")}, Required: []string{"x1", "y1", "x2", "y2"}},
	{Name: "press_key", Desc: "Press a system key: back, home, recents, notifications (open the shade), quick_settings, lock, or screenshot (saved to the gallery).",
		Props: map[string]any{"key": enum("Key", "back", "home", "recents", "notifications", "quick_settings", "lock", "screenshot")}, Required: []string{"key"}},
	{Name: "wait_for", ReadOnly: true, Desc: "Wait until some text appears on screen (up to timeout_ms, default 8000) and return the screen.",
		Props: map[string]any{"text": str("Text to wait for"), "timeout_ms": num("Timeout in milliseconds, max 30000")}, Required: []string{"text"}},
	{Name: "open_app", Desc: "Open an installed app by name (for example \"WhatsApp\", \"Settings\", \"Chrome\") or package name.",
		Props: map[string]any{"name": str("App name or package")}, Required: []string{"name"}},
	{Name: "list_apps", ReadOnly: true, Desc: "List the installed apps (names and package names)."},
	{Name: "open_url", Desc: "Open a link in the phone's browser or the app that handles it.",
		Props: map[string]any{"url": str("URL")}, Required: []string{"url"}},
	{Name: "play_music", Desc: "Play music from a search: a song, artist, album, playlist or mood (\"Diljit Dosanjh\", \"lofi for focus\", \"my liked songs\"). Opens the music app and starts the best match. Empty query resumes or plays something.",
		Props: map[string]any{"query": str("What to play"), "app": str("youtube_music (default), spotify, default (the phone's default player), or a package name")}},
	{Name: "media", Desc: "Control whatever is playing (any app): play, pause, toggle, next, previous, stop, volume_up, volume_down, mute, unmute, set_volume (level 0-100), or status. Returns whether music is playing and the media volume.",
		Props: map[string]any{"action": enum("Action", "play", "pause", "toggle", "next", "previous", "stop", "volume_up", "volume_down", "mute", "unmute", "set_volume", "status"), "level": num("Volume 0-100 for set_volume")}, Required: []string{"action"}},
	{Name: "start_intent", Desc: "Start any Android intent, for things without a dedicated tool: deep links (whatsapp://send?phone=91XXXXXXXXXX&text=..., google.navigation:q=..., geo:0,0?q=..., https://maps.google.com/?q=...), app actions (android.intent.action.WEB_SEARCH with extras {\"query\": ...}), or a package-specific VIEW. Nothing is sent or paid automatically; the user still confirms in the app.",
		Props: map[string]any{"action": str("Intent action, default android.intent.action.VIEW"), "data": str("Data URI"), "type": str("MIME type"), "package": str("Target package"), "category": str("Category"), "extras": map[string]any{"type": "object", "description": "Extras (strings, numbers, booleans)"}}},
	{Name: "set_alarm", Desc: "Set an alarm in the clock app.",
		Props: map[string]any{"hour": num("Hour, 0-23"), "minute": num("Minute, 0-59"), "label": str("Optional label")}, Required: []string{"hour"}},
	{Name: "set_timer", Desc: "Start a countdown timer in the clock app.",
		Props: map[string]any{"seconds": num("Length in seconds"), "label": str("Optional label")}, Required: []string{"seconds"}},
	{Name: "add_calendar_event", Desc: "Open the calendar with a new event filled in (local time, format YYYY-MM-DDTHH:MM). The event is saved when Save is tapped.",
		Props: map[string]any{"title": str("Title"), "start": str("Start, YYYY-MM-DDTHH:MM"), "end": str("End, YYYY-MM-DDTHH:MM"), "location": str("Location"), "description": str("Notes")}, Required: []string{"title", "start"}},
	{Name: "compose_message", Desc: "Open a draft SMS, email, or the dialler with a number. Nothing is sent or called until Send/Call is tapped.",
		Props: map[string]any{"kind": enum("What to open", "sms", "email", "call"), "to": str("Phone number or email address"), "text": str("Message"), "subject": str("Email subject")}, Required: []string{"kind"}},
	{Name: "share_text", Desc: "Open the share sheet with some text.",
		Props: map[string]any{"text": str("Text to share")}, Required: []string{"text"}},
	{Name: "open_settings", Desc: "Open a settings page.",
		Props: map[string]any{"page": enum("Page", "main", "wifi", "bluetooth", "display", "sound", "battery", "apps", "location", "notifications", "dnd")}},
	{Name: "notifications", ReadOnly: true, Desc: "Recent notifications seen while phone control has been on (app and text)."},
	{Name: "clipboard", Desc: "Read the clipboard, or set it when text is given.",
		Props: map[string]any{"text": str("Text to copy (omit to read)")}},
	{Name: "unlock", Desc: "Ask the user to unlock the phone: Android shows its own fingerprint, face or PIN prompt. Use when phone_status says locked and the task needs other apps. Questions, answers, alarms and timers often work without unlocking."},
	{Name: "back_to_skiff", Desc: "Bring the Skiff app back to the front. Only use at the end of a task the user started inside the Skiff app (not from the floating bubble or voice) when they will want to read the answer there."},
	{Name: "phone_status", ReadOnly: true, Desc: "Phone status: whether phone control is on, whether the phone is locked and the screen on, battery, device, app in front."},
}

const phoneInstructions = `These tools act on the user's own Android phone, which they asked you to use.
Work like a careful person holding the phone: call read_screen first, act on element ids, and check the screen returned after each action before the next step.
Prefer direct tools (set_alarm, set_timer, open_app, compose_message) over tapping through menus.
Risky actions (sending, paying, deleting, anything in banking or password apps) show an Allow/Deny prompt on the phone; if one is denied, stop and ask the user.
Never enter passwords, one-time codes or payment details unless the user typed them to you for that purpose.
When you finish, say briefly what you did and leave the phone on the screen the user would expect.

WhatsApp (com.whatsapp): open_app "WhatsApp"; the Chats list shows names, last message, time and unread counts. Tap a chat to open it; read_screen shows its recent messages; scroll up to read older ones (repeat until you have enough). Use the search icon to find a chat or message. To summarize, read first, then answer; to reply, type into the message field and only send when the user asked you to send (sending asks on the phone).
Music: prefer play_music (YouTube Music by default) and media for pause/next/volume. For listening history or favourites in YouTube Music open the app: Library shows History, Liked music and playlists.
Notifications: the notifications tool lists recent ones seen while phone control was on; for everything currently in the shade use press_key notifications, then read_screen, then press_key back.
Assistant: the user may have opened Skiff with the side button, possibly on the lock screen, and is talking by voice. Keep spoken answers short and natural (no tables or long lists unless asked). If phone_status says locked and you need other apps, call unlock first; if it stays locked, say so briefly.
Long tasks: work screen by screen and keep going until done; tell the user what you found in a short, organised answer.`

func (a *App) phonePort() string { return os.Getenv("SKIFF_PHONE_PORT") }

// phoneAvailable: the app passes SKIFF_PHONE_PORT when its phone server runs.
func (a *App) phoneAvailable() bool { return a.phonePort() != "" && a.phonePort() != "0" }

// handlePhoneCall forwards a tool call to the app's phone server.
func (a *App) handlePhoneCall(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		httpErr(w, err, 400)
		return
	}
	if !a.phoneAvailable() {
		writeJSON(w, map[string]any{"ok": false, "error": "Phone control works only in the Skiff app on Android."})
		return
	}
	var req struct {
		Tool string          `json:"tool"`
		Args json.RawMessage `json:"args"`
	}
	_ = json.Unmarshal(body, &req)
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Minute)
	defer cancel()
	preq, _ := http.NewRequestWithContext(ctx, "POST", "http://127.0.0.1:"+a.phonePort()+"/call", bytes.NewReader(body))
	preq.Header.Set("X-Skiff-Token", a.cfg.Token)
	preq.Header.Set("Content-Type", "application/json")
	resp, err := (&http.Client{}).Do(preq)
	if err != nil {
		writeJSON(w, map[string]any{"ok": false, "error": "The Skiff app did not answer: " + err.Error()})
		return
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(resp.Body)
	log.Printf("phone: %s %s → %d bytes", req.Tool, truncate(string(req.Args), 120), len(out))
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(out)
}

func truncate(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n]) + "…"
	}
	return s
}

// writeSession records how to reach skiffd for MCP servers started by an
// interactive Claude Code (they may not inherit SKIFF_URL/SKIFF_TOKEN).
func (a *App) writeSession() {
	p := a.hostPath(a.guestHome() + "/.skiff/session.json")
	_ = os.MkdirAll(filepath.Dir(p), 0o700)
	b, _ := json.Marshal(map[string]string{"url": fmt.Sprintf("http://127.0.0.1:%d", a.cfg.Port), "token": a.cfg.Token})
	_ = os.WriteFile(p, b, 0o600)
}

// registerPhoneMCP adds the phone tools to interactive Claude Code (user
// scope) and allows them, since risky actions are confirmed on the phone.
func (a *App) registerPhoneMCP() {
	// only inside the app's own Ubuntu: never edit a desktop user's ~/.claude
	if !a.cfg.Android || !a.phoneAvailable() || !a.ready() || !a.claudeInstalled() {
		return
	}
	home := a.guestHome()
	cfgPath := a.hostPath(home + "/.claude.json")
	if b, err := os.ReadFile(cfgPath); err == nil && strings.Contains(string(b), "mcp-phone") {
		a.allowPhoneTools()
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	out, err := a.guestOutput(ctx, "~/.local/bin/claude mcp add --scope user phone -- /opt/skiff/libskiffd.so mcp-phone 2>&1")
	log.Printf("phone: registered with Claude Code: %v %s", err, strings.TrimSpace(out))
	a.allowPhoneTools()
}

func (a *App) allowPhoneTools() {
	p := a.hostPath(a.guestHome() + "/.claude/settings.json")
	var s map[string]any
	if b, err := os.ReadFile(p); err == nil {
		if json.Unmarshal(b, &s) != nil {
			return // don't touch a settings file we can't parse
		}
	}
	if s == nil {
		s = map[string]any{}
	}
	perms, _ := s["permissions"].(map[string]any)
	if perms == nil {
		perms = map[string]any{}
	}
	allow, _ := perms["allow"].([]any)
	for _, x := range allow {
		if x == "mcp__phone" {
			return
		}
	}
	perms["allow"] = append(allow, "mcp__phone")
	s["permissions"] = perms
	b, _ := json.MarshalIndent(s, "", "  ")
	_ = os.MkdirAll(filepath.Dir(p), 0o755)
	_ = os.WriteFile(p, b, 0o644)
}

// ---- the MCP server Claude Code talks to ----

func runMCPPhone() int {
	base, token := os.Getenv("SKIFF_URL"), os.Getenv("SKIFF_TOKEN")
	if b, err := os.ReadFile(filepath.Join(os.Getenv("HOME"), ".skiff", "session.json")); err == nil {
		var s struct{ URL, Token string }
		if json.Unmarshal(b, &s) == nil && s.Token != "" {
			base, token = s.URL, s.Token // the file is always current; env may be stale
		}
	}
	in := bufio.NewReader(os.Stdin)
	out := json.NewEncoder(os.Stdout)
	reply := func(id json.RawMessage, result any) {
		_ = out.Encode(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
	}
	for {
		line, err := in.ReadBytes('\n')
		if len(bytes.TrimSpace(line)) > 0 {
			var req struct {
				ID     json.RawMessage `json:"id"`
				Method string          `json:"method"`
				Params json.RawMessage `json:"params"`
			}
			if json.Unmarshal(line, &req) == nil && len(req.ID) > 0 {
				switch req.Method {
				case "initialize":
					var p struct {
						ProtocolVersion string `json:"protocolVersion"`
					}
					_ = json.Unmarshal(req.Params, &p)
					if p.ProtocolVersion == "" {
						p.ProtocolVersion = "2025-06-18"
					}
					reply(req.ID, map[string]any{"protocolVersion": p.ProtocolVersion,
						"capabilities": map[string]any{"tools": map[string]any{}},
						"serverInfo":   map[string]any{"name": "skiff-phone", "version": version},
						"instructions": phoneInstructions})
				case "ping":
					reply(req.ID, map[string]any{})
				case "tools/list":
					list := []any{}
					for _, t := range phoneTools {
						props := t.Props
						if props == nil {
							props = map[string]any{}
						}
						schema := map[string]any{"type": "object", "properties": props}
						if len(t.Required) > 0 {
							schema["required"] = t.Required
						}
						list = append(list, map[string]any{"name": t.Name, "description": t.Desc, "inputSchema": schema,
							"annotations": map[string]any{"readOnlyHint": t.ReadOnly}})
					}
					reply(req.ID, map[string]any{"tools": list})
				case "tools/call":
					var p struct {
						Name      string          `json:"name"`
						Arguments json.RawMessage `json:"arguments"`
					}
					_ = json.Unmarshal(req.Params, &p)
					reply(req.ID, callPhone(base, token, p.Name, p.Arguments))
				default:
					_ = out.Encode(map[string]any{"jsonrpc": "2.0", "id": req.ID, "error": map[string]any{"code": -32601, "message": "method not found"}})
				}
			}
		}
		if err != nil {
			return 0
		}
	}
}

// callPhone runs one tool and shapes the result for Claude: screens as
// readable text, screenshots as images, errors flagged.
func callPhone(base, token, name string, args json.RawMessage) map[string]any {
	tool := name
	if tool == "phone_status" {
		tool = "status"
	}
	if len(args) == 0 || string(args) == "null" {
		args = json.RawMessage("{}")
	}
	body, _ := json.Marshal(map[string]any{"tool": tool, "args": args})
	textResult := func(s string, isErr bool) map[string]any {
		return map[string]any{"content": []any{map[string]any{"type": "text", "text": s}}, "isError": isErr}
	}
	req, _ := http.NewRequest("POST", base+"/api/phone/call", bytes.NewReader(body))
	req.Header.Set("X-Skiff-Token", token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := (&http.Client{Timeout: 4 * time.Minute}).Do(req)
	if err != nil {
		return textResult("Skiff is not reachable: "+err.Error(), true)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var r map[string]any
	if json.Unmarshal(raw, &r) != nil {
		return textResult(string(raw), true)
	}
	if e, ok := r["error"].(string); ok && e != "" {
		return textResult(e, true)
	}
	if img, ok := r["image"].(string); ok {
		mime, _ := r["mime"].(string)
		return map[string]any{"content": []any{map[string]any{"type": "image", "data": img, "mimeType": mime}}}
	}
	var sb strings.Builder
	writeScreen := func(s map[string]any, heading string) {
		app, _ := s["appName"].(string)
		if app == "" {
			app, _ = s["app"].(string)
		}
		fmt.Fprintf(&sb, "%sApp: %s\n%s", heading, app, s["screen"])
	}
	switch {
	case r["screen"] != nil:
		writeScreen(r, "")
		if f, ok := r["found"].(bool); ok {
			fmt.Fprintf(&sb, "\nfound: %v", f)
		}
	case r["after"] != nil:
		ok, _ := r["ok"].(bool)
		fmt.Fprintf(&sb, "ok: %v\n", ok)
		if after, isMap := r["after"].(map[string]any); isMap {
			writeScreen(after, "Screen now:\n")
		}
	default:
		b, _ := json.MarshalIndent(r, "", " ")
		sb.Write(b)
	}
	return textResult(strings.TrimSpace(sb.String()), false)
}
