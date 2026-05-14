# AI Secretary Design Context

## Visual Direction
A cozy desktop companion overlay: dark violet night-sky ambience, soft cyan and pink accents, readable chat surfaces, and clear status indicators. Ari's avatar is the hero; UI chrome should support her rather than compete.

## Color
Use OKLCH where practical. Base palette is deep violet neutrals with cyan for system/status, pink for warmth and primary actions, amber only for active/research states. Avoid pure black and pure white.

## Typography
System UI fonts. Text should be compact but readable. Chat bubbles should target 55 to 70 characters per line and avoid oversized blocks.

## Components
- Avatar status pill: small, legible, stateful.
- Chat bubble: conversational, not dashboard-card heavy.
- Top icon buttons: visible, tactile, with clear hover/focus states.
- Routines/reminders: should clearly distinguish user routines from test/dev content.

## Motion
Motion should feel alive but gentle. Do not animate layout. Prefer opacity, transform, and status changes.

## UX Priorities
- Startup should show a clear ready state.
- If audio is muted or blocked, show a visible hint and recovery button.
- Test or debug messages must never appear in normal user replies.
- Screenshots should be part of the validation loop.
