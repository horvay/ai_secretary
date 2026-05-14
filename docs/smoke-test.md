# AI Secretary Smoke Test

Goal: test Ari end-to-end. Prefer **one long-lived app run** for UI smoke. Use **local llama** for local voice/model smoke. Use **normal secretary asking** for tool-backed routine/reminder creation because local llama app backend is a voice JSON/router backend and does not execute reminder/routine tools.

Rules: Bun only. Show full output. GUI is real. VAAPI/GDK/Wayland noise usually ok. Cleanup after.

## 0. Cleanup first

```bash
pkill -f "[e]lectron build/electron/main.cjs" || true
pkill -f "[b]uild/electron/backend.js" || true
pkill -f "[t]ools/mcp-playwright-electron.ts" || true
pkill -f "[m]cp-playwright-electron" || true
pkill -f "[l]lama-server" || true
mkdir -p artifacts
rm -f artifacts/smoke-*.png artifacts/electron-mcp-chat-test.png
```

## 1. Baseline checks

```bash
bun run check
bun run build
bun run start -- --help
```

## 2. Fast non-GUI tests

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

## 3. Backend / pi / brain tests

```bash
bun scripts/test-pi-client.ts
bun scripts/test-brain-tools.ts
bun scripts/test-brain-tools-isolated.ts
```

## 4. Local AI integration test

Default AI smoke:

```bash
bun test src/bun/services/ariVoiceJsonService.integration.test.ts
```

Optional pi/tool regression:

```bash
bun test src/bun/services/ariVoiceJsonService.big-pickle.integration.test.ts
```

## 5. Main local app smoke: one run, multiple turns

This launches real Electron once with local llama:

```txt
--agent-backend local-llama
```

Use the voice JSON path:

```js
__aiSecretaryTest.askQuestion(prompt, false, false, { source: 'voice', voiceMode: 'ari-decides' })
```

Run:

```bash
bun - <<'TS'
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const transport = new StdioClientTransport({ command: 'bun', args: ['tools/mcp-playwright-electron.ts'], env: process.env as Record<string,string> });
const client = new Client({ name: 'local-one-run-smoke', version: '0.1.0' });
async function tool(name, args = {}) { console.log(`\n--- ${name} ---`); const r = await client.callTool({ name, arguments: args }); console.log(r); return r; }
async function ask(prompt) {
  return tool('electron_eval_renderer', { script: `globalThis.__aiSecretaryTest.askQuestion(${JSON.stringify(prompt)}, false, false, { source: 'voice', voiceMode: 'ari-decides' }).then((r) => JSON.stringify(r))` });
}
await client.connect(transport);
try {
  await tool('electron_launch', { build: false, timeoutMs: 120000, args: ['--agent-backend', 'local-llama'] });
  await new Promise((r) => setTimeout(r, 15000));
  await tool('electron_eval_renderer', { script: `typeof globalThis.__aiSecretaryTest + ' | ' + document.body.innerText.slice(0, 200)` });
  await ask('Ari, say exactly: local one complete.');
  await new Promise((r) => setTimeout(r, 2500));
  await ask('Ari, say exactly: local two complete.');
  await new Promise((r) => setTimeout(r, 2500));
  await ask('Ari, say exactly: local three complete.');
  await new Promise((r) => setTimeout(r, 2500));
  await tool('electron_eval_renderer', { script: `globalThis.__aiSecretaryTest.openSettings().then(() => 'settings-open')` });
  await new Promise((r) => setTimeout(r, 2000));
  await tool('electron_screenshot', { path: 'artifacts/smoke-local-one-run-settings.png' });
  await tool('electron_eval_renderer', { script: `globalThis.__aiSecretaryTest.openModal('current-session').then(() => 'history-open')` });
  await new Promise((r) => setTimeout(r, 2000));
  await tool('electron_screenshot', { path: 'artifacts/smoke-local-one-run-history.png' });
  await tool('electron_eval_renderer', { script: `document.body.innerText` });
  await tool('electron_console_messages', {});
} finally {
  await tool('electron_close', {}).catch(() => undefined);
  await client.close();
}
TS
```

Pass: `[local-llama] Starting`, three same-run asks complete, renderer has latest response, screenshots saved, `electron_close` runs.

## 6. Deterministic routine/reminder CRUD smoke

This is the CRUD smoke. It intentionally uses app-owned smoke RPC to create fixture data deterministically, then verifies the normal UI can display/delete it. Do not depend on model behavior for CRUD smoke setup.

Run in one app session:

```bash
bun - <<'TS'
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const transport = new StdioClientTransport({ command: 'bun', args: ['tools/mcp-playwright-electron.ts'], env: process.env as Record<string,string> });
const client = new Client({ name: 'secretary-crud-smoke', version: '0.1.0' });
async function tool(name, args = {}) { console.log(`\n--- ${name} ---`); const r = await client.callTool({ name, arguments: args }); console.log(r); return r; }
const stamp = Date.now();
const routineName = `SMOKE_ROUTINE_${stamp}`;
const reminderContent = `SMOKE_REMINDER_${stamp}`;
await client.connect(transport);
try {
  await tool('electron_launch', { build: false, timeoutMs: 120000 });
  await new Promise((r) => setTimeout(r, 12000));

  await tool('electron_eval_renderer', {
    script: `globalThis.__smokeNames = ${JSON.stringify({ routineName, reminderContent })}; globalThis.__aiSecretaryTest.setMicrophoneEnabled(false).then(() => 'names-set-mic-off')`,
  });

  await tool('electron_eval_renderer', {
    script: `window.electronAPI.request('createSmokeRoutineAndReminder', globalThis.__smokeNames).then((r) => JSON.stringify(r))`,
  });

  await new Promise((r) => setTimeout(r, 5000));

  // DB/RPC verification. Yes, CLI tools can also read the DB:
  // bun resources/tools/manage-routines.ts list
  // bun resources/tools/manage-reminders.ts list
  await tool('electron_eval_renderer', {
    script: `window.electronAPI.request('readSmokeRoutineReminderState', globalThis.__smokeNames).then((r) => JSON.stringify(r))`,
  });

  await tool('electron_eval_renderer', { script: `globalThis.__aiSecretaryTest.openModal('routines').then(() => 'routines-open')` });
  await new Promise((r) => setTimeout(r, 1500));
  await tool('electron_screenshot', { path: 'artifacts/smoke-secretary-routines-before-delete.png' });

  await tool('electron_eval_renderer', {
    script: `(() => { const name = globalThis.__smokeNames.routineName; const item = [...document.querySelectorAll('.routine-item')].find((el) => el.textContent.includes(name)); item?.querySelector('[data-action="delete"]')?.click(); return Boolean(item); })()`,
  });
  await new Promise((r) => setTimeout(r, 1500));

  await tool('electron_eval_renderer', { script: `globalThis.__aiSecretaryTest.openModal('reminders').then(() => 'reminders-open')` });
  await new Promise((r) => setTimeout(r, 1500));
  await tool('electron_screenshot', { path: 'artifacts/smoke-secretary-reminders-before-delete.png' });

  await tool('electron_eval_renderer', {
    script: `(() => { const content = globalThis.__smokeNames.reminderContent; const item = [...document.querySelectorAll('.routine-item')].find((el) => el.textContent.includes(content)); item?.querySelector('[data-action="delete-reminder"]')?.click(); return Boolean(item); })()`,
  });
  await new Promise((r) => setTimeout(r, 1500));

  await tool('electron_eval_renderer', {
    script: `window.electronAPI.request('readSmokeRoutineReminderState', globalThis.__smokeNames).then((r) => JSON.stringify(r))`,
  });

  // Safety cleanup in case UI delete missed anything.
  await tool('electron_eval_renderer', {
    script: `window.electronAPI.request('cleanupSmokeRoutineAndReminder', globalThis.__smokeNames).then((r) => JSON.stringify(r))`,
  });

  await tool('electron_console_messages', {});
} finally {
  await tool('electron_close', {}).catch(() => undefined);
  await client.close();
}
TS
```

Pass:

- Smoke RPC creates the fixture routine/reminder.
- DB state shows the smoke routine/reminder after creation.
- UI screenshots show routine/reminder before deletion.
- UI delete buttons remove them.
- Final DB state is empty, or safety cleanup deletes leftovers.

## 7. CLI DB inspection

Yes, we can read the DB with CLI tools:

```bash
bun resources/tools/manage-routines.ts list
bun resources/tools/manage-reminders.ts list
```

Or raw SQLite via Bun if needed:

```bash
bun - <<'TS'
import { Database } from 'bun:sqlite';
import { homedir } from 'os';
import { join } from 'path';
const dataDir = process.env.AI_SECRETARY_DATA_DIR || join(homedir(), '.ai-secretary');
const db = new Database(join(dataDir, 'memory', 'memory.db'));
console.log(db.query('select id,name,enabled from routines order by id desc limit 10').all());
console.log(db.query('select id,content,status from reminders order by id desc limit 10').all());
TS
```

## 8. Cleanup after

```bash
pkill -f "[e]lectron build/electron/main.cjs" || true
pkill -f "[b]uild/electron/backend.js" || true
pkill -f "[t]ools/mcp-playwright-electron.ts" || true
pkill -f "[m]cp-playwright-electron" || true
pkill -f "[l]lama-server" || true
ps -ef | awk '/ai_secretary|mcp-playwright-electron|build\/electron\/backend.js|electron build\/electron\/main.cjs|llama-server/ && !/awk/ { print }'
```

Optional artifact cleanup:

```bash
rm -f artifacts/smoke-*.png artifacts/electron-mcp-chat-test.png
```

## Quick local smoke

```bash
bun run check
bun run build
bun test src/bun/services/ariVoiceJsonService.integration.test.ts
```

Then run section 5.

## Full smoke

Run sections 0 through 8. Section 6 uses normal secretary/Big Pickle because local llama does not execute CRUD tools.
