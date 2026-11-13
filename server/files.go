package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io/fs"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"
)

type fsEntry struct {
	Name  string `json:"name"`
	Dir   bool   `json:"dir"`
	Size  int64  `json:"size"`
	Mtime int64  `json:"mtime"`
	Link  bool   `json:"link,omitempty"`
}

func (a *App) handleFsList(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Query().Get("path")
	if p == "" {
		p = a.guestHome()
	}
	hidden := r.URL.Query().Get("hidden") == "1"
	ents, err := os.ReadDir(a.hostPath(p))
	if err != nil {
		httpErr(w, err, 404)
		return
	}
	out := []fsEntry{}
	for _, e := range ents {
		if !hidden && strings.HasPrefix(e.Name(), ".") {
			continue
		}
		fe := fsEntry{Name: e.Name(), Dir: e.IsDir(), Link: e.Type()&fs.ModeSymlink != 0}
		if info, err := e.Info(); err == nil {
			fe.Size, fe.Mtime = info.Size(), info.ModTime().Unix()
		}
		if fe.Link {
			if st, err := os.Stat(filepath.Join(a.hostPath(p), e.Name())); err == nil {
				fe.Dir = st.IsDir()
			}
		}
		out = append(out, fe)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Dir != out[j].Dir {
			return out[i].Dir
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	writeJSON(w, map[string]any{"path": path.Clean(p), "entries": out})
}

func (a *App) handleFsRead(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Query().Get("path")
	hp := a.hostPath(p)
	st, err := os.Stat(hp)
	if err != nil {
		httpErr(w, err, 404)
		return
	}
	if r.URL.Query().Get("raw") == "1" {
		if ct := mime.TypeByExtension(filepath.Ext(hp)); ct != "" {
			w.Header().Set("Content-Type", ct)
		}
		http.ServeFile(w, r, hp)
		return
	}
	if st.Size() > 4<<20 {
		writeJSON(w, map[string]any{"path": p, "tooLarge": true, "size": st.Size()})
		return
	}
	b, err := os.ReadFile(hp)
	if err != nil {
		httpErr(w, err, 500)
		return
	}
	if !utf8.Valid(b) || bytes.IndexByte(b, 0) >= 0 {
		writeJSON(w, map[string]any{"path": p, "binary": true, "size": st.Size()})
		return
	}
	writeJSON(w, map[string]any{"path": p, "content": string(b), "size": st.Size(), "mtime": st.ModTime().Unix()})
}

func (a *App) handleFsWrite(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path    string `json:"path"`
		Content string `json:"content"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Path == "" {
		httpErr(w, errors.New("path required"), 400)
		return
	}
	hp := a.hostPath(req.Path)
	_ = os.MkdirAll(filepath.Dir(hp), 0o755)
	mode := os.FileMode(0o644)
	if st, err := os.Stat(hp); err == nil {
		mode = st.Mode().Perm()
	}
	if err := os.WriteFile(hp, []byte(req.Content), mode); err != nil {
		httpErr(w, err, 500)
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}

func (a *App) handleFsMkdir(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path string `json:"path"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	if err := os.MkdirAll(a.hostPath(req.Path), 0o755); err != nil {
		httpErr(w, err, 500)
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}

func (a *App) handleFsDelete(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path string `json:"path"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	clean := path.Clean("/" + req.Path)
	if clean == "/" || clean == a.guestHome() {
		httpErr(w, errors.New("refusing to delete that"), 400)
		return
	}
	if err := os.RemoveAll(a.hostPath(clean)); err != nil {
		httpErr(w, err, 500)
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}

func (a *App) handleFsRename(w http.ResponseWriter, r *http.Request) {
	var req struct {
		From string `json:"from"`
		To   string `json:"to"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	if err := os.Rename(a.hostPath(req.From), a.hostPath(req.To)); err != nil {
		httpErr(w, err, 500)
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}

var skipDirs = map[string]bool{".git": true, "node_modules": true, "target": true, "dist": true, "build": true, ".next": true, ".venv": true, "__pycache__": true, ".cache": true, "vendor": true}

// handleFsFind lists files under root whose relative path contains q, for
// @-mentions in the chat composer.
func (a *App) handleFsFind(w http.ResponseWriter, r *http.Request) {
	root := r.URL.Query().Get("root")
	q := strings.ToLower(r.URL.Query().Get("q"))
	hroot := a.hostPath(root)
	var out []string
	seen := 0
	errStop := errors.New("stop")
	_ = filepath.WalkDir(hroot, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if p != hroot && (skipDirs[d.Name()] || strings.HasPrefix(d.Name(), ".")) {
				return filepath.SkipDir
			}
			return nil
		}
		seen++
		if seen > 20000 || len(out) >= 60 {
			return errStop
		}
		rel, _ := filepath.Rel(hroot, p)
		if q == "" || strings.Contains(strings.ToLower(rel), q) {
			out = append(out, filepath.ToSlash(rel))
		}
		return nil
	})
	sort.Slice(out, func(i, j int) bool { return len(out[i]) < len(out[j]) })
	writeJSON(w, out)
}
