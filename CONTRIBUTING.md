# Contributing

Thanks for helping. A few notes keep Skiff small and dependable:

* **No new build systems.** The APK is built by `build.sh` with plain
  Android tools; please keep it that way. See [docs/building.md](docs/building.md).
* **Claude Code stays unmodified.** Skiff talks to it through documented
  interfaces (stream-json, MCP, control requests) only.
* **UI** lives in `web/src` (Preact + htm, no JSX build step). Keep the
  assistant bundle (`assist.js`) small.
* **Test without an account** using `test/fakeclaude` (see its README).
* Run `go vet ./...` in `server/` and build the APK before opening a PR.

Code is dual-licensed MIT OR Apache-2.0; by contributing you agree your
contribution is licensed the same way.
