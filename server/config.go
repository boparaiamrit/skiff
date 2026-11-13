package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Config is read from the environment the Android app sets.
type Config struct {
	Home      string   // app files dir: everything Skiff owns lives here
	Port      int      // UI/API port on 127.0.0.1
	Token     string   // per-launch secret; required on every request
	Android   bool     // running on Android (proot + Ubuntu) or on a dev machine
	NativeDir string   // dir holding libskiffd.so (bound into the guest as /opt/skiff)
	DNS       []string // DNS servers from Android's active network
	Self      string   // path of this executable
}

func loadConfig() (*Config, error) {
	c := &Config{
		Home:      os.Getenv("SKIFF_HOME"),
		Token:     os.Getenv("SKIFF_TOKEN"),
		Android:   os.Getenv("SKIFF_ANDROID") == "1",
		NativeDir: os.Getenv("SKIFF_NATIVE_DIR"),
	}
	if c.Home == "" {
		h, _ := os.UserHomeDir()
		c.Home = filepath.Join(h, ".skiff")
	}
	c.Port = 37321
	if p := os.Getenv("SKIFF_PORT"); p != "" {
		n, err := strconv.Atoi(p)
		if err != nil {
			return nil, fmt.Errorf("SKIFF_PORT: %w", err)
		}
		c.Port = n
	}
	if c.Token == "" {
		b := make([]byte, 16)
		_, _ = rand.Read(b)
		c.Token = hex.EncodeToString(b)
		fmt.Fprintf(os.Stderr, "no SKIFF_TOKEN set; open http://127.0.0.1:%d/?t=%s\n", c.Port, c.Token)
	}
	for _, s := range strings.Split(os.Getenv("SKIFF_DNS"), ",") {
		if s = strings.TrimSpace(s); s != "" {
			c.DNS = append(c.DNS, s)
		}
	}
	if len(c.DNS) == 0 {
		c.DNS = []string{"1.1.1.1", "8.8.8.8"}
	}
	c.Self, _ = os.Executable()
	if c.NativeDir == "" {
		c.NativeDir = filepath.Dir(c.Self)
	}
	for _, d := range []string{c.Home, c.path("tmp"), c.path("logs"), c.path("runtime")} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return nil, err
		}
	}
	os.Setenv("TMPDIR", c.path("tmp"))
	if c.Android && os.Getenv("SSL_CERT_DIR") == "" {
		// A GOOS=linux binary doesn't know Android's CA store; without this
		// every HTTPS download in setup fails certificate verification.
		os.Setenv("SSL_CERT_DIR", "/apex/com.android.conscrypt/cacerts:/system/etc/security/cacerts")
	}
	return c, nil
}

func (c *Config) path(p ...string) string { return filepath.Join(append([]string{c.Home}, p...)...) }

// Rootfs is the Ubuntu root filesystem on Android.
func (c *Config) Rootfs() string { return c.path("ubuntu") }

// logRing keeps the last lines of the server log for the in-app log viewer.
type logRing struct {
	mu    sync.Mutex
	lines []string
	part  string
}

var serverLog = &logRing{}

func (r *logRing) Write(p []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	s := r.part + string(p)
	parts := strings.Split(s, "\n")
	r.part = parts[len(parts)-1]
	r.lines = append(r.lines, parts[:len(parts)-1]...)
	if len(r.lines) > 2000 {
		r.lines = r.lines[len(r.lines)-2000:]
	}
	return len(p), nil
}

func (r *logRing) String() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return strings.Join(r.lines, "\n") + "\n" + r.part
}

func setupLogging(c *Config) {
	f, err := os.OpenFile(c.path("logs", "skiffd.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	var w io.Writer = io.MultiWriter(os.Stderr, serverLog)
	if err == nil {
		if st, _ := f.Stat(); st != nil && st.Size() > 4<<20 {
			_ = f.Truncate(0)
		}
		w = io.MultiWriter(os.Stderr, serverLog, f)
	}
	log.SetOutput(w)
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
}

// installResolver makes Go's pure-Go resolver use Android's DNS servers.
// A static linux binary on Android finds no /etc/resolv.conf and would
// otherwise try 127.0.0.1:53.
func installResolver(servers []string) {
	if _, err := os.Stat("/etc/resolv.conf"); err == nil {
		return
	}
	var idx int
	var mu sync.Mutex
	net.DefaultResolver = &net.Resolver{
		PreferGo: true,
		Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
			mu.Lock()
			s := servers[idx%len(servers)]
			idx++
			mu.Unlock()
			if strings.Contains(s, ":") && !strings.HasPrefix(s, "[") {
				s = "[" + s + "]"
			}
			d := net.Dialer{Timeout: 5 * time.Second}
			return d.DialContext(ctx, network, s+":53")
		},
	}
}
