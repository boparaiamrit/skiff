package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// On-device speech-to-text with whisper.cpp, built inside Ubuntu. The UI
// records 16 kHz WAV and posts it to /api/voice/transcribe.

const (
	whisperDir   = "/opt/whisper.cpp"
	whisperModel = "ggml-base-q5_1.bin"
)

var (
	voiceMu      sync.Mutex
	voiceBusy    bool
	voiceSeq     atomic.Int64
	whisperLines []string
)

func (a *App) whisperCLI() string {
	if !a.cfg.Android {
		if p := os.Getenv("SKIFF_WHISPER_CLI"); p != "" {
			return p
		}
	}
	return whisperDir + "/build/bin/whisper-cli"
}

func (a *App) whisperModelPath() string {
	if !a.cfg.Android {
		if p := os.Getenv("SKIFF_WHISPER_MODEL"); p != "" {
			return p
		}
	}
	return whisperDir + "/models/" + whisperModel
}

func (a *App) whisperReady() bool {
	return fileExists(a.hostPath(a.whisperCLI())) && fileExists(a.hostPath(a.whisperModelPath()))
}

func (a *App) handleVoiceStatus(w http.ResponseWriter, r *http.Request) {
	voiceMu.Lock()
	busy := voiceBusy
	lines := append([]string(nil), whisperLines...)
	voiceMu.Unlock()
	if len(lines) > 30 {
		lines = lines[len(lines)-30:]
	}
	writeJSON(w, map[string]any{"whisper": a.whisperReady(), "installing": busy, "model": whisperModel, "lines": lines})
}

// handleVoiceInstall builds whisper.cpp and downloads a small multilingual
// model (base, 5-bit quantised, ~60 MB) inside Ubuntu.
func (a *App) handleVoiceInstall(w http.ResponseWriter, r *http.Request) {
	if !a.cfg.Android {
		httpErr(w, errors.New("on a desktop, set SKIFF_WHISPER_CLI and SKIFF_WHISPER_MODEL instead"), 400)
		return
	}
	if !a.ready() {
		httpErr(w, errors.New("finish Setup first"), 400)
		return
	}
	voiceMu.Lock()
	if voiceBusy {
		voiceMu.Unlock()
		writeJSON(w, map[string]any{"ok": true, "note": "already installing"})
		return
	}
	voiceBusy = true
	whisperLines = nil
	voiceMu.Unlock()
	writeJSON(w, map[string]any{"ok": true})

	go func() {
		defer func() {
			voiceMu.Lock()
			voiceBusy = false
			voiceMu.Unlock()
		}()
		pub := func(state string, extra map[string]any) {
			ev := map[string]any{"type": "voice", "state": state}
			for k, v := range extra {
				ev[k] = v
			}
			a.events.publish(ev)
		}
		line := func(l string) {
			voiceMu.Lock()
			whisperLines = append(whisperLines, l)
			if len(whisperLines) > 400 {
				whisperLines = whisperLines[len(whisperLines)-400:]
			}
			voiceMu.Unlock()
			pub("log", map[string]any{"line": l})
		}
		ctx, cancel := context.WithTimeout(context.Background(), 45*time.Minute)
		defer cancel()
		script := fmt.Sprintf(`set -e
echo "==> build tools"
apt-get install -y build-essential cmake git curl
if [ -d %[1]s/.git ]; then echo "==> updating whisper.cpp"; git -C %[1]s pull --ff-only || true
else echo "==> downloading whisper.cpp"; git clone --depth 1 https://github.com/ggml-org/whisper.cpp %[1]s; fi
echo "==> compiling (a few minutes)"
cmake -S %[1]s -B %[1]s/build -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF -DBUILD_SHARED_LIBS=OFF
cmake --build %[1]s/build -j"$(nproc)" --config Release --target whisper-cli
mkdir -p %[1]s/models
if [ ! -s %[1]s/models/%[2]s ]; then
  echo "==> downloading the speech model (about 60 MB)"
  curl -fL --retry 3 -o %[1]s/models/%[2]s.part https://huggingface.co/ggerganov/whisper.cpp/resolve/main/%[2]s
  mv %[1]s/models/%[2]s.part %[1]s/models/%[2]s
fi
echo "==> done"`, whisperDir, whisperModel)
		pub("running", map[string]any{"line": "Installing Whisper…"})
		if err := a.runGuestLines(ctx, script, false, "", line); err != nil {
			pub("error", map[string]any{"message": "Whisper install failed: " + err.Error()})
			return
		}
		pub("done", nil)
	}()
}

var whisperNoise = regexp.MustCompile(`(?i)^\s*[\[(](blank_audio|music|silence|inaudible|no speech)[\])]\s*$`)

// handleVoiceTranscribe runs whisper-cli on a posted WAV file.
func (a *App) handleVoiceTranscribe(w http.ResponseWriter, r *http.Request) {
	if !a.whisperReady() {
		httpErr(w, errors.New("Whisper is not installed: open Setup → Voice"), 400)
		return
	}
	n := voiceSeq.Add(1)
	guestWav := fmt.Sprintf("/tmp/skiff-voice-%d.wav", n)
	hostWav := a.hostPath(guestWav)
	_ = os.MkdirAll(filepath.Dir(hostWav), 0o777)
	f, err := os.Create(hostWav)
	if err != nil {
		httpErr(w, err, 500)
		return
	}
	size, err := io.Copy(f, io.LimitReader(r.Body, 50<<20))
	f.Close()
	defer os.Remove(hostWav)
	if err != nil || size < 1000 {
		httpErr(w, errors.New("no audio received"), 400)
		return
	}
	lang := r.URL.Query().Get("lang")
	if lang == "" || !regexp.MustCompile(`^[a-z]{2,3}$|^auto$`).MatchString(lang) {
		lang = "auto"
	}
	start := time.Now()
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Minute)
	defer cancel()
	var out strings.Builder
	script := fmt.Sprintf("%s -m %s -f %s -l %s -t $(nproc) -nt -np 2>/dev/null",
		shellQuote(a.whisperCLI()), shellQuote(a.whisperModelPath()), shellQuote(guestWav), lang)
	if !a.cfg.Android {
		script = fmt.Sprintf("%s -m %s -f %s -l %s -nt -np 2>/dev/null", shellQuote(a.whisperCLI()), shellQuote(a.whisperModelPath()), shellQuote(hostWav), lang)
	}
	err = a.runGuestLines(ctx, script, false, "", func(l string) {
		if !whisperNoise.MatchString(l) {
			out.WriteString(strings.TrimSpace(l) + " ")
		}
	})
	text := strings.TrimSpace(out.String())
	log.Printf("voice: %d bytes → %q in %s (err=%v)", size, text, time.Since(start).Round(time.Millisecond), err)
	if err != nil && text == "" {
		httpErr(w, fmt.Errorf("whisper failed: %v", err), 500)
		return
	}
	writeJSON(w, map[string]any{"text": text, "ms": time.Since(start).Milliseconds()})
}
