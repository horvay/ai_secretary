# GBrain Contract Notes

Verified against local checkout `reference/gbrain` at commit `ee9ceb3`.

## Integration Surface

Production AI Secretary code should not parse human-oriented `gbrain search` or `gbrain query` output. Use JSON-capable surfaces:

- `gbrain call <operation> '<json>'`
- future option: stdio MCP via `gbrain serve`

The first implementation uses `gbrain call` because it is simple, JSON-shaped, and fail-soft.

## Operation Names

Use MCP/core operation names for `gbrain call`:

- `search` with `{ "query": string, "limit"?: number }`
- `query` with `{ "query": string, "limit"?: number, "expand"?: boolean }`
- `get_page` with `{ "slug": string }`
- `put_page` with `{ "slug": string, "content": string }`

CLI aliases differ for some operations:

- CLI `gbrain get` maps to operation `get_page`
- CLI `gbrain put` maps to operation `put_page`

## Health/Setup

There is no approved `gbrain status` command. Status checks should use:

- `gbrain version` for install/version detection
- `gbrain doctor --json --fast` for configured/healthy detection

If GBrain is missing or unconfigured, AI Secretary must continue without GBrain context.

## Current Limitations

- GBrain is disabled by default in AI Secretary settings.
- The current implementation is read-only for normal turns.
- Writes are blocked unless `gbrain.writeMode` is explicitly `auto`.
- `memory.enabled=false` disables GBrain context lookup.
