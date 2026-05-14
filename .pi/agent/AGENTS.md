# AI Secretary embedded pi config

This local pi config is used by the AI Secretary app's embedded pi backend.

- Do not load or depend on the user's global `~/.pi/agent` config.
- Ari persona and app behavior should come from this repository/runtime, not from personal global instructions.
- Default temporary model target: OpenCode Zen `opencode/big-pickle`.
