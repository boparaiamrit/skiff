# Changelog

## 0.4.5
* Fixed garbled lines in code diffs (a style clash with the context meter).
* Clearer approval questions in the assistant ("Can I edit a file?").
* First public release on GitHub.

## 0.4.4: only your voice
* While listening, Skiff takes Android's audio focus: music and videos pause
  and resume afterwards.
* Mic level is measured against the room's background noise; turns end about
  a second after your voice stops, and the ring no longer flickers.
* The assistant's big button does nothing while Claude works (a separate Stop
  does), so a late "Done" can't cancel a request.

## 0.4.3
* Voice-mode button and floating bubble glow no longer clipped.

## 0.4.2: turns that always end
* Skiff ends the turn itself when the recognizer doesn't, and **Done** always
  sends what was heard. Whisper adapts to background noise.
* The green → cyan → violet look across the app; the bubble gets a gradient
  ring that turns while Claude works.

## 0.4.1: a real assistant UI
* A dedicated, minimal assistant: one card, one button, a working pill while
  Claude uses the phone, spoken questions and approvals.
* Warm start and short spoken answers for assistant conversations.

## 0.4.0: replace Gemini
* Skiff is a digital assistant: hold the side button to talk to Claude, also
  on the lock screen, with Android's own unlock prompt when needed.
* On-device speech recognition option.

## 0.3.x: hands, bubble and templates
* Phone control through an accessibility service, with on-screen
  confirmations for risky actions and a Stop banner.
* Floating chat bubble over every app.
* 122 ready-made templates; music and media tools; Lucide icons.

## 0.2.x: voice, GitHub, history
* Voice input and voice mode (phone speech or Whisper).
* GitHub sign-in (device flow), repo picker and clone; folder picker.
* Conversations survive updates; past conversations across projects.

## 0.1.x: first light
* Ubuntu 24.04 under proot, official Claude Code, chat with tool cards,
  diffs and permission prompts, terminals, files, preview.
