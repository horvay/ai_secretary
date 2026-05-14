# Runtime and Companion Pack Reorganization Plan

## Goal

Make AI Secretary easier to package, test, update, reset, and extend by separating:

1. **Core app capabilities** — critical functionality owned by the app and always available internally.
2. **Companion pack content** — replaceable personality, presentation, and optional behavior configuration.
3. **Mutable user data** — private state that is never source-controlled or bundled as immutable app resources.

The guiding rule:

> Critical things for the app must not be part of a companion pack. Everything non-critical and character-specific should live in the companion pack.

## Current problem

`runtime/` currently mixes too many concerns:

- Built-in assets: `runtime/packs`, sprites, personas, OCR data.
- App tools: `runtime/tools/*.ts`.
- Mutable user data: `runtime/memory/memory.db`, screenshots, logs, app state.
- Pi session working directory.
- Git submodule content.

This causes constant dirty git state, fragile path logic, difficult packaging, duplicated database/tool code, and unclear ownership.

## Target ownership model

### Core app-owned, not companion-pack-owned

These must live in `src/` or shipped app resources, not in packs:

- Electron shell/windowing/IPC.
- Backend lifecycle and RPC.
- Settings system and app state storage.
- Memory database schema, migrations, retention, privacy, and storage paths.
- Reminders, routines, tasks, lists implementations.
- Scheduler and notification delivery.
- Screenshot capture backends and platform detection.
- OCR/transcription/TTS infrastructure.
- Agent backend integrations: Pi SDK, local Llama, model server lifecycle.
- Tool execution framework and permission enforcement.
- Security/privacy boundaries.
- Built-in smoke tests and diagnostics.
- Core resource/path resolution.

Companion packs may enable, disable, style, or describe these capabilities, but must not own their implementations.

### Companion-pack-owned

These should live in packs:

- Persona prompt and character voice.
- Visual identity: sprites, avatar states, animation assets.
- Marker vocabulary: allowed `[state:*]` and `[anim:*]` values.
- Pack-specific skills/extensions.
- Pack-specific default model preference.
- Pack-specific capability policy, e.g. screenshots enabled/disabled for this character.
- Pack-specific UI labels/descriptions where appropriate.
- Pack-specific example prompts or behavioral notes.
- Optional voice style defaults, if we later support multiple voices.

Important distinction:

```txt
The app owns "how reminders work".
The pack may decide "this companion exposes reminders" and "how the companion talks about reminders".
```

### User-data-owned

These should live outside the repo, under the AI Secretary data directory:

```txt
~/.ai-secretary/
  memory/
    memory.db
    screenshots/
    exports/
  packs/
    user-installed-pack/
  pi/
    sessions/
  cache/
    sprites/
    models/
  logs/
  config/
```

Use `AI_SECRETARY_DATA_DIR` for tests and portable/dev overrides.

## Target directory structure

```txt
resources/
  app/
    AGENTS.md
  ocr/
    eng.traineddata
  companion-packs/
    ari/
      pack.json
      persona.md
      assets/
        sprites/
      skills/
      extensions/
    ari-work/
      pack.json
      persona.md
      skills/
      extensions/

src/
  bun/
    app/
    services/
    features/
    tools/
      remindersTool.ts
      routinesTool.ts
      tasksTool.ts
      listsTool.ts
      memoryTool.ts
    utils/
      paths.ts
  shared/
  avatar/
  electron/

~/.ai-secretary/
  memory/
  packs/
  pi/
  cache/
  logs/
```

Long term, `runtime/` should either disappear or become a generated, ignored dev/runtime cache. It should not remain the canonical place for bundled app resources and mutable user data.

## Companion pack manifest v2

Introduce a versioned manifest with explicit pack inheritance and clear boundaries.

Example:

```json
{
  "schemaVersion": 2,
  "id": "ari-work",
  "name": "Ari Workmode",
  "version": "1.0.0",
  "extends": "ari",
  "description": "Focused, work-first Ari pack",
  "persona": {
    "file": "persona.md",
    "mode": "replace"
  },
  "sprites": {
    "source": "ari"
  },
  "markers": {
    "states": ["normal"],
    "animations": ["yawn", "dance"]
  },
  "capabilities": {
    "memory": true,
    "reminders": true,
    "lists": false,
    "tasks": true,
    "routines": false,
    "screenshots": false,
    "playwright": false
  },
  "model": {
    "providerID": "opencode",
    "modelID": "big-pickle"
  },
  "skillsDir": "skills",
  "extensionsDir": "extensions"
}
```

Benefits:

- Replaces symlinks like `ari-work/assets/sprites -> ../../ari/assets/sprites`.
- Makes inheritance portable across platforms and packaging formats.
- Allows lightweight derivative packs.
- Enables schema validation and migration.

## Pack lookup order

Use explicit pack sources:

```ts
type CompanionPackSource = "env" | "user" | "project" | "builtin";
```

Lookup order:

1. `AI_SECRETARY_PACK_DIRS` / explicit env paths for tests.
2. User packs: `${AI_SECRETARY_DATA_DIR}/packs`.
3. Project packs: `<projectRoot>/packs` for development.
4. Built-in packs: `<resourcesDir>/companion-packs`.

Higher-priority packs may override lower-priority packs with the same ID, but the UI should show the source.

## Centralized path service

Replace scattered path discovery with one source of truth:

```ts
getProjectRootDir()
getResourcesDir()
getBuiltinCompanionPacksDir()
getUserDataDir()
getUserMemoryDir()
getUserPacksDir()
getPiDataDir()
getCacheDir()
getLogsDir()
```

Rules:

- All mutable writes use `getUserDataDir()` or children.
- All shipped read-only resources use `getResourcesDir()`.
- Tests use `AI_SECRETARY_DATA_DIR`.
- Avoid `cwd.includes("/build/")` style detection.

## Tool architecture

Move runtime tools out of `runtime/tools` into source-owned app tools.

Current:

```txt
Pi tool -> spawn bun runtime/tools/manage-reminders.ts -> direct SQLite logic
```

Target:

```txt
Core service -> app tool function -> adapters
```

Adapters:

- Pi SDK custom tool adapter.
- CLI adapter for manual testing.
- UI/debug smoke adapter.
- Unit/integration tests.

Example structure:

```txt
src/bun/tools/reminders.ts      # parses tool args and calls services
src/bun/services/reminders.ts   # domain logic
src/bun/rpc/handlers/...        # UI transport adapter
```

This removes duplicated SQLite path logic and keeps implementation type-safe.

## Implemented migration policy

### Non-negotiable: no legacy fallback logic

Do not implement fallback paths to the old `runtime/` layout. Once a phase moves a responsibility, the app must use only the new location for that responsibility. This intentionally makes broken or missing resources fail loudly instead of silently reading stale legacy state.

Allowed transition behavior:

- One explicit, user-invoked migration command/script may copy data from the old layout to the new layout.
- Tests may create fresh data/resources in the new layout.
- Error messages may mention the expected new path.

Disallowed transition behavior:

- Runtime path search chains that check both new and old locations.
- Automatic fallback from `resources/` or `${AI_SECRETARY_DATA_DIR}` back to `runtime/`.
- Automatic use of old `runtime/memory`, `runtime/packs`, or `runtime/tools` if new paths are missing.

### Phase 0: Stabilize and document

- Add this plan.
- Add a runtime inventory doc showing current contents and owners.
- Add tests around current pack loading and sprite loading before moving files.

### Completed: Centralize paths

- Expand `src/bun/utils/paths.ts` into the only path resolver.
- Update memory DB, screenshots, logs, companion packs, Pi sessions, and cache callers to use it.
- Add `AI_SECRETARY_RESOURCES_DIR` and `AI_SECRETARY_DATA_DIR` support.
- Do not keep compatibility with old `runtime/` paths during transition.

### Completed: Move mutable memory out of runtime

- New default memory location: `${AI_SECRETARY_DATA_DIR}/memory/memory.db`.
- On startup, always use the new DB path. Do not auto-copy or fallback to `runtime/memory`.
- If old data needs to be preserved, run a separate explicit migration script before launching the app.
- Move screenshots and exports into user data.
- Stop writing new files under `runtime/memory`.

### Completed: Split resources from runtime

- Create `resources/app/AGENTS.md`.
- Move OCR data to `resources/ocr/eng.traineddata`.
- Move built-in packs to `resources/companion-packs`.
- Update packaging scripts to copy `resources/`, not `runtime/`.
- Ensure user memory is never copied into packaged builds.

### Phase 4: Companion pack manifest v2

- Add v2 manifest parser while supporting current v1 manifests.
- Add `extends` and `sprites.source` support.
- Convert `ari-work` from symlink-based sprite sharing to manifest inheritance.
- Rename pack source labels from `runtime/project` to `builtin/user/project/env`.
- Add validation for inherited assets and marker subsets.

### Phase 5: Move runtime tools into app-owned source

- Reimplement each runtime tool as source-owned tool modules:
  - reminders
  - routines
  - tasks
  - lists
  - memory search
  - brain search/page lookup
  - screenshot capture
- Keep CLI wrappers for manual testing.
- Update Pi custom tool creation to call source functions directly where possible.
- Remove duplicated DB path discovery from tool scripts.

### Completed: Retire runtime submodule as active runtime

`runtime/` is removed from git tracking and ignored as a legacy local directory. The app no longer uses it for resources, tools, memory, packs, or Pi workspace state.

The app must not write into a git submodule during normal operation.

## Testing requirements

For each phase:

- `bun run check`
- Existing CLI smoke tests.
- UI smoke test with screenshot and local Llama when screenshot paths change.
- Pack loading test:
  - default Ari loads
  - Ari Workmode loads
  - inherited sprites resolve
  - invalid pack fails with clear errors
- Memory migration test using `AI_SECRETARY_DATA_DIR` and a fixture old `runtime/memory`.
- Pack source priority test.
- Packaging smoke test ensuring no user memory DB is bundled.

## Success criteria

- Root repo no longer becomes dirty from normal app usage.
- Companion packs can be added/removed without touching core app code.
- Critical app features still work with a minimal/no-op companion pack.
- User data is clearly separated and portable.
- Built-in resources are read-only and package-safe.
- Pack inheritance works without symlinks.
- Tool implementations are not duplicated between app, Pi, and CLI.
