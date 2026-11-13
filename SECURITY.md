# Security

Skiff runs an AI agent that can use your phone, so it is built to keep that
power on a short leash.

## What Skiff does

* **Local only.** `skiffd` listens on `127.0.0.1`. Every request needs a
  random per-launch token (an `HttpOnly`, `SameSite=Strict` cookie in the
  app, a header for tools inside Ubuntu). The phone server inside the app
  checks the same token.
* **No credentials.** Skiff never sees your Anthropic or GitHub credentials:
  Claude Code's `/login` and `gh auth login` open their own pages in your
  browser.
* **Unmodified Claude Code**, installed with Anthropic's own installer.
* **Approvals.** Chat permission prompts reach you through an MCP
  permission server; questions and plan approvals always ask.
* **Phone control is opt-in** (an accessibility service you turn on), shows
  a Stop banner while acting, and asks on screen before risky actions and
  before anything in banking, UPI, wallet or password apps. Android hides
  password fields from accessibility services. Direct phone calls are
  refused. See [docs/phone-control.md](docs/phone-control.md).
* **Unlocking** uses Android's own prompt; Skiff never sees a PIN.

## What to be aware of

* Skiff targets Android API 28 so proot can run programs (like Termux), which
  is why Play Protect warns about it.
* "Never ask" in phone control lets Claude act without confirmations. Use it
  only for tasks you are watching.
* Anything you allow Claude to do inside Ubuntu runs with your files there.

## Reporting a vulnerability

Please open a private security advisory on this repository
(**Security → Report a vulnerability**) rather than a public issue.
