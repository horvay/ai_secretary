# AI Secretary

A cute avatar AI companion desktop app built with Electron.

## Features

- 🤖 **AI Companion**: Powered by OpenCode for coding assistance and general queries
- 🎤 **Text-to-Speech**: Offline Piper TTS for voice responses
- 📸 **Context Awareness**: Screenshot capture for understanding user context
- 📝 **Notes System**: File-based note storage for conversation history
- 🎨 **Cute Avatar**: Sprite-based animations with draggable, always-on-top window

## Prerequisites

1. **OpenCode**: The app will automatically start its own OpenCode server instance. Make sure OpenCode is installed:
   ```bash
   curl -fsSL https://opencode.ai/install | bash
   ```
   The app will spawn `opencode serve` automatically on startup.

2. **Avatar Assets**: Place your sprite sheet in `src/avatar/sprites/avatar.png` (or `avatar-sheet.png`)
   - If assets are missing, a red placeholder box will be shown
   - Sprite sheet should contain frames for: idle, thinking, talking states

## Installation

```bash
bun install
```

## Development

```bash
bun start
```

This will:
1. Build the app
2. Download Piper TTS binary and model on first run (if not already installed)
3. Launch the avatar window

## Usage

- **Click the avatar** or press `Ctrl/Cmd + K` to open the input modal
- **Type your question** and press Enter or click Send
- The avatar will:
  1. Show "thinking" animation
  2. Query OpenCode with your question
  3. Display the response in a chat bubble
  4. Speak the response using TTS
  5. Return to "idle" state

## Project Structure

```
ai_secretary/
├── src/
│   ├── bun/              # Main process
│   │   ├── services/     # OpenCode, Piper, Screenshot, Notes
│   │   └── utils/        # Downloader utility
│   ├── avatar/            # Avatar webview
│   │   ├── components/   # Avatar, ChatBubble, InputModal
│   │   └── sprites/      # Avatar sprite assets (add your assets here)
│   └── reference/        # Old playground demos (for reference)
└── data/                  # Downloaded data (Piper, notes)
```

## Notes

Notes are stored in `~/AISecretary/notes/` as Markdown files. Each AI response is automatically saved.

## Configuration

- OpenCode server URL: `http://127.0.0.1:4096` (configurable in `src/bun/services/opencode.ts`)
- Piper models: Downloaded to `~/.ai-secretary/piper/` on first run
- Notes directory: `~/AISecretary/notes/`

## Building

```bash
bun run build:dev    # Development build
bun run build:canary # Canary build
```

## Troubleshooting

- **OpenCode not starting**:
  - Make sure OpenCode is installed: `curl -fsSL https://opencode.ai/install | bash`
  - Check the console logs for OpenCode startup errors
  - The app will show an error message if OpenCode fails to start
- **TTS not working**: Check that Piper binary and model downloaded successfully (check `~/.ai-secretary/piper/`)
- **Missing avatar assets**: A red placeholder box will be shown - add your sprite sheet to `src/avatar/sprites/`
