// Command skiffd is the local backend of Skiff: a mobile workspace for
// running Claude Code and a Linux environment on an Android phone.
//
// The Android app starts it as a child process and shows its web UI in a
// WebView. It listens on 127.0.0.1 only and every request must carry the
// per-launch token the app passes in SKIFF_TOKEN.
//
// Subcommands:
//
//	skiffd               serve the UI and API (default)
//	skiffd mcp-approve   MCP stdio server used as Claude Code's permission prompt tool
//	skiffd open URL      ask the app to open URL in the phone's browser
package main

import (
	"context"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

var version = "0.4.4"

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "mcp-approve":
			os.Exit(runMCPApprove())
		case "mcp-phone":
			os.Exit(runMCPPhone())
		case "open":
			os.Exit(runOpen(os.Args[2:]))
		case "version", "--version":
			fmt.Println("skiffd", version)
			return
		}
	}
	if err := serve(); err != nil {
		log.Printf("fatal: %v", err)
		os.Exit(1)
	}
}

func serve() error {
	cfg, err := loadConfig()
	if err != nil {
		return err
	}
	setupLogging(cfg)
	installResolver(cfg.DNS)
	log.Printf("skiffd %s starting: home=%s port=%d android=%v native=%s", version, cfg.Home, cfg.Port, cfg.Android, cfg.NativeDir)

	app := newApp(cfg)
	mux := http.NewServeMux()
	app.routes(mux)
	app.writeSession()
	go app.registerPhoneMCP()

	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", cfg.Port))
	if err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	srv := &http.Server{Handler: app.auth(mux), ReadHeaderTimeout: 10 * time.Second}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		log.Printf("shutting down")
		app.shutdown()
		sctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = srv.Shutdown(sctx)
	}()
	log.Printf("listening on http://127.0.0.1:%d", cfg.Port)
	if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
		return err
	}
	return nil
}
