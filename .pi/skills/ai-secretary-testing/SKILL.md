---
name: ai-secretary-testing
description: "Use for AI Secretary testing: checks, backend/pi, brain tools, local AI integrations, GUI smoke tests, and Playwright Electron MCP UI/chat tests. Project-local only."
---

# AI Secretary Testing

Use when user says test, smoke, verify, Ari, UI, MCP, backend, brain, local AI.

## Rules

- Bun only. No npm.
- Show full output. No grep hiding.
- GUI real. Not headless.
- VAAPI/GDK/Wayland noise usually ok.
- Cleanup after: Electron, backend, MCP, llama-server.
- Do not commit unless asked.

## Main doc

Full checklist lives here:

```txt
docs/smoke-test.md
```

Read it before big smoke runs.

## Baseline

```bash
bun run check
bun run build
bun run start -- --help
```

## Fast tests

```bash
bun run start -- --test-input-filter
bun run start -- --test-ari-decision
bun run start -- --test-anim-marker dance
bun run start -- --test-bracket-strip
bun run start -- --test-sprites-runtime
bun test src/avatar/services/VoiceInputPipeline.test.ts
bun test src/bun/services/audio.test.ts
bun test src/bun/services/scheduler/reminder-engine.test.ts
bun test src/bun/services/scheduler/routine-engine.test.ts
bun test src/bun/utils/voiceDecision.test.ts
```

## Backend / brain

```bash
bun scripts/test-pi-client.ts
bun scripts/test-brain-tools.ts
bun scripts/test-brain-tools-isolated.ts
```

## Local model first

Use local llama for smoke, not Big Pickle:

```bash
bun test src/bun/services/ariVoiceJsonService.integration.test.ts
```

Big Pickle only if pi/tool path changed:

```bash
bun test src/bun/services/ariVoiceJsonService.big-pickle.integration.test.ts
```

## MCP local app smoke

Use one app run. Launch with local backend:

```json
{
  "build": false,
  "timeoutMs": 120000,
  "args": ["--agent-backend", "local-llama"]
}
```

Local app smoke uses Ari voice JSON path:

```js
globalThis.__aiSecretaryTest.askQuestion(
  'Ari, say exactly: local one complete.',
  false,
  false,
  { source: 'voice', voiceMode: 'ari-decides' }
)
```

Then do several asks in same run, open UI, screenshots, logs, close.

MCP tools:

- `electron_launch`
- `electron_eval_renderer`
- `electron_screenshot`
- `electron_console_messages`
- `electron_close`

Look for:

- `[local-llama] Starting`
- multiple `askQuestion`
- `delivered: true`
- renderer text has latest response
- screenshots saved
- `electron_close`

## Cleanup

```bash
pkill -f "[e]lectron build/electron/main.cjs" || true
pkill -f "[b]uild/electron/backend.js" || true
pkill -f "[t]ools/mcp-playwright-electron.ts" || true
pkill -f "[m]cp-playwright-electron" || true
pkill -f "[l]lama-server" || true
```
