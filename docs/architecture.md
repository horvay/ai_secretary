# AI Secretary Architecture

This app is split into four long-lived layers:

1. **Electron shell** (`src/electron`) owns desktop windows, preload IPC, platform quirks, and the backend process bridge.
2. **Backend application** (`src/bun`) owns orchestration, AI/voice/memory/routine features, persistence, and infrastructure adapters.
3. **Renderer/avatar** (`src/avatar`) owns DOM UI, microphone capture, local playback, modals, and renderer-side RPC handlers.
4. **Shared contracts** (`src/shared`) owns types that cross process boundaries, especially RPC request/message contracts.

Preferred dependency direction:

```txt
src/shared  <- imported by everyone
src/electron -> src/shared only where possible
src/bun      -> src/shared + backend feature/infrastructure modules
src/avatar   -> src/shared + avatar modules
```

RPC handlers should stay thin:

```txt
RPC handler -> feature/application service -> domain service -> infrastructure adapter
```

Avoid adding orchestration to large entry files. If a file starts coordinating multiple features, extract a feature controller or service first.

## Current extraction priorities

- Keep `src/bun/rpc/handlers/*` as transport adapters.
- Move assistant turn orchestration into `src/bun/features/assistant-turn/`.
- Move renderer startup behavior out of `src/avatar/index.ts` into `src/avatar/app/` and `src/avatar/features/*`.
- Split large UI components into feature folders and matching CSS files.
- Keep cross-process contracts in `src/shared/rpc`; do not import backend-only types from the renderer.
