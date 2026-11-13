# Tests and fakes

`fakeclaude/claude` stands in for `claude -p --input-format stream-json
--output-format stream-json`, so the chat, permission and phone pipelines can
be exercised without an Anthropic account. It emits realistic events
(streaming text, tool calls, a TodoWrite list, an Edit that asks for
permission over MCP) and reacts to a few words in your message:

| Say | It does |
|---|---|
| anything | reads files, plans, asks to edit `hello.txt` |
| "ask" | asks two questions with `AskUserQuestion` |
| "phone" | calls the `phone` MCP tools (read screen, tap, screenshot, set alarm) |
| "slow" | waits 8 seconds first |

```sh
cd server
PATH=$PWD/../test/fakeclaude:$PATH SKIFF_TOKEN=dev go run .
```
