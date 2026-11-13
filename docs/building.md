# Building Skiff

There is no Gradle and no Android Studio project. `build.sh` builds the web
UI, the Go backend and the Android shell with the plain Android build tools.

## Requirements

* Node 20+ and npm
* Go 1.24+
* A JDK (17 or newer) for `javac`
* Android build tools: `aapt`, `dx`, `zipalign`, `apksigner`
* An `android.jar` for API 34. `build.sh` fetches one into `android/sdk/`
  if it is missing.

On Ubuntu or Debian:

```sh
sudo apt install openjdk-17-jdk-headless aapt dalvik-exchange zipalign apksigner
(cd web && npm ci)
./build.sh            # → build/skiff.apk
```

`build.sh` creates a signing key in `keys/` on the first run. **Keep it**:
Android only installs updates signed with the same key, and `keys/` is
git-ignored on purpose.

Useful overrides: `ANDROID_JAR=/path/to/android.jar`,
`BUILD_TOOLS=/path/to/build-tools` (for `dx`), `KEYSTORE=/path/to/key`.

## What build.sh does

1. `web/`: esbuild bundles `app.js` and `assist.js` into `server/dist/`.
2. `server/`: `CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build` → a static
   `libskiffd.so` with the UI embedded.
3. `android/`: `aapt` packages resources and generates `R.java`, `javac`
   compiles against `android.jar`, `dx` makes `classes.dex`.
4. The APK is assembled, `zipalign`ed and signed with `apksigner`.

## Run on a desktop

`skiffd` also runs on Linux or macOS, using your own shell and the `claude`
on your PATH. Handy for working on the UI:

```sh
(cd web && npm ci && node build.mjs)
cd server && SKIFF_TOKEN=dev go run .
# open http://127.0.0.1:37321/?t=dev
```

Without an Anthropic account, use the fake Claude Code in
[`test/fakeclaude`](../test/fakeclaude):

```sh
PATH=$PWD/../test/fakeclaude:$PATH SKIFF_TOKEN=dev go run .
```

Set `SKIFF_PHONE_PORT` to a local HTTP server that answers `POST /call` to
try the phone tools without a phone.

## Layout

| Path | What it is |
|---|---|
| `android/` | The Android app (Java): activity, foreground service, JS bridge, accessibility service and phone tools, floating bubble, digital assistant |
| `server/` | `skiffd` (Go): API, terminals, chat bridge, MCP servers, setup, Whisper |
| `web/` | The UI (Preact + htm): `src/main.js` (app) and `src/assist.js` (side-button assistant) |
| `test/` | A fake `claude` for testing the chat and phone pipeline |
| `docs/` | These documents and the README's images |
