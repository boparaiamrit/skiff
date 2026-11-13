package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"
)

// runMCPApprove is a minimal MCP server over stdio exposing one tool,
// "approve", which Claude Code calls (as --permission-prompt-tool) before it
// uses a tool that needs permission. It forwards the request to skiffd and
// waits for the user's answer from the chat UI.
func runMCPApprove() int {
	base := os.Getenv("SKIFF_URL")
	token := os.Getenv("SKIFF_TOKEN")
	chat := os.Getenv("SKIFF_CHAT")
	in := bufio.NewReader(os.Stdin)
	out := json.NewEncoder(os.Stdout)
	client := &http.Client{Timeout: 0}

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
					reply(req.ID, map[string]any{
						"protocolVersion": p.ProtocolVersion,
						"capabilities":    map[string]any{"tools": map[string]any{}},
						"serverInfo":      map[string]any{"name": "skiff", "version": version},
					})
				case "ping":
					reply(req.ID, map[string]any{})
				case "tools/list":
					reply(req.ID, map[string]any{"tools": []any{map[string]any{
						"name":        "approve",
						"description": "Ask the Skiff user to approve or deny a tool call.",
						"inputSchema": map[string]any{
							"type": "object",
							"properties": map[string]any{
								"tool_name":   map[string]any{"type": "string"},
								"input":       map[string]any{"type": "object"},
								"tool_use_id": map[string]any{"type": "string"},
							},
							"required": []string{"tool_name", "input"},
						},
					}}})
				case "tools/call":
					var p struct {
						Name      string          `json:"name"`
						Arguments json.RawMessage `json:"arguments"`
					}
					_ = json.Unmarshal(req.Params, &p)
					text := askSkiff(client, base, token, chat, p.Arguments)
					reply(req.ID, map[string]any{"content": []any{map[string]any{"type": "text", "text": text}}})
				default:
					_ = out.Encode(map[string]any{"jsonrpc": "2.0", "id": req.ID,
						"error": map[string]any{"code": -32601, "message": "method not found"}})
				}
			}
		}
		if err != nil {
			return 0
		}
	}
}

func askSkiff(client *http.Client, base, token, chat string, args json.RawMessage) string {
	var a map[string]any
	_ = json.Unmarshal(args, &a)
	if a == nil {
		a = map[string]any{}
	}
	a["chat"] = chat
	body, _ := json.Marshal(a)
	deny := func(msg string) string {
		b, _ := json.Marshal(map[string]any{"behavior": "deny", "message": msg})
		return string(b)
	}
	for attempt := 0; attempt < 3; attempt++ {
		req, _ := http.NewRequest("POST", base+"/api/internal/approve", bytes.NewReader(body))
		req.Header.Set("X-Skiff-Token", token)
		req.Header.Set("Content-Type", "application/json")
		resp, err := client.Do(req)
		if err != nil {
			time.Sleep(time.Second)
			continue
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != 200 {
			return deny(fmt.Sprintf("Skiff approval failed: %s", resp.Status))
		}
		return string(bytes.TrimSpace(b))
	}
	return deny("Skiff is not reachable to ask for permission")
}

// runOpen asks the app to open a URL in the phone's browser (used as $BROWSER).
func runOpen(args []string) int {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "usage: skiff-open URL")
		return 2
	}
	base, token := os.Getenv("SKIFF_URL"), os.Getenv("SKIFF_TOKEN")
	if base == "" {
		fmt.Fprintln(os.Stderr, "skiff-open: SKIFF_URL is not set")
		return 1
	}
	body, _ := json.Marshal(map[string]string{"url": args[0]})
	req, _ := http.NewRequest("POST", base+"/api/open", bytes.NewReader(body))
	req.Header.Set("X-Skiff-Token", token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		fmt.Fprintln(os.Stderr, "skiff-open:", err)
		return 1
	}
	resp.Body.Close()
	fmt.Fprintf(os.Stderr, "Opening in your browser: %s\n", args[0])
	return 0
}
