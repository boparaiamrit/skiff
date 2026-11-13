# Phone control

Claude can use the phone itself when you ask: read what is on screen, tap,
type, scroll, open apps, play music, set alarms and timers, draft messages
and calendar events, read notifications and the clipboard. It works from
Chat, voice mode, the floating bubble, the side-button assistant and
**Terminal → Claude Code**.

## Turning it on

1. **Setup → Phone control → Turn on** opens Android's Accessibility
   settings: **Installed apps → Skiff phone control → On**.
2. Android 13+ treats sideloaded apps' accessibility services as
   *restricted*. If it says so: Skiff's **App info → ⋮ → Allow restricted
   settings**, then turn it on.

> **Play Protect in India (and other countries):** its enhanced fraud
> protection blocks any app installed from a browser, file manager or chat
> app if it declares an accessibility service ("App blocked to protect your
> device"). Install with **Play Store → profile → Play Protect → ⚙ → Scan
> apps with Play Protect: off**, then turn it back on. Updates need the same
> step.

## Safety

Safety lives on the phone, not in chat approvals:

* A banner with **Stop** shows while Claude acts. Stop refuses every further
  action until you resume in Setup.
* **Ask before** (Setup → Phone control):
  * **Risky actions** (default): sending, paying, buying, deleting, calling,
    posting, installing, signing out, and *anything* inside banking, UPI,
    wallet or password-manager apps asks **Deny / Allow / Allow all for 30
    minutes** on screen first.
  * **Every action** asks before each tap, keystroke or app launch.
  * **Never ask** for trusted, supervised tasks.
* Android hides password fields from accessibility services; Skiff never
  sees PINs or passwords. Unlocking uses Android's own prompt.
* Direct calls are refused; Claude can only open the dialler.
* Skiff's own windows (chat, bubble, assistant) are left out of screen reads,
  and step aside while Claude taps.

## Tools

| Tool | What it does |
|---|---|
| `read_screen` | The app in front and a numbered list of elements with ids, states and coordinates |
| `screenshot` | A JPEG of the screen (Android 11+), for images, maps and canvases |
| `tap`, `long_press` | By element id, visible text, or x,y |
| `type` | Into a field (replace or append), optionally pressing enter/send |
| `scroll`, `swipe` | Lists and gestures |
| `press_key` | back, home, recents, notifications, quick settings, lock, screenshot |
| `wait_for` | Until some text appears |
| `open_app`, `list_apps` | By name or package |
| `open_url`, `start_intent` | Links, deep links (`whatsapp://send…`, `google.navigation:q=…`) and any Android intent |
| `play_music` | Play from a search in YouTube Music (default), Spotify or the default player |
| `media` | play, pause, next, previous, volume, mute for whatever is playing |
| `set_alarm`, `set_timer`, `add_calendar_event` | Through the clock and calendar apps |
| `compose_message`, `share_text` | Draft an SMS or email, open the dialler, share sheet |
| `open_settings` | Wi-Fi, Bluetooth, display, sound, battery, apps, location, notifications, Do Not Disturb |
| `notifications`, `clipboard` | Recent notifications; read or set the clipboard |
| `unlock` | Shows Android's unlock prompt when a task needs it |
| `back_to_skiff`, `phone_status` | Return to Skiff; locked/screen state, battery, device, app in front |

The MCP server's instructions tell Claude to read the screen first, act on
element ids, check the screen after each action, prefer direct tools
(alarms, music) over tapping through menus, and never enter passwords.

## Template library

**Things I can do** (from the empty chat or **+**) has 122 ready-made
requests in 14 groups: WhatsApp and messages, music, catch-up, time and
calendar, on-screen help, phone settings, routines, travel, shopping and
bills, social and news, photos and files, code, writing, and health. It is
searchable, remembers your recent picks, and fills blanks (a contact, a
time) with a small form. The list lives in
[`web/src/templates.js`](../web/src/templates.js).

## In Terminal → Claude Code

Skiff registers the tools once for interactive Claude Code:

```sh
claude mcp add --scope user phone -- /opt/skiff/libskiffd.so mcp-phone
```

and allows `mcp__phone` in `~/.claude/settings.json`, because confirmations
already happen on the phone.
