# Cursor Agent for VS Code

Chat with the [Cursor Agent CLI](https://cursor.com/docs/cli) from the VS Code sidebar.

## Install

Download the `.vsix` from Releases, then:

```
code --install-extension cursor-agent-<version>.vsix
```

## Setup

Open the Cursor view with `Cmd+Alt+C` (`Ctrl+Alt+C` on Windows and Linux). If the Cursor Agent CLI isn't installed or signed in yet, the view walks you through both.

Everything else is in the settings, behind the gear in the chat header.

## Keys

| Key | Action |
| --- | --- |
| `Cmd+Alt+C` | Open Cursor |
| `Cmd+Alt+A` | Add the selection to the chat |
| `Enter` / `Shift+Enter` | Send / new line |
| `Esc` | Stop the current turn |

Use `Ctrl` in place of `Cmd` on Windows and Linux.

## Development

```
npm install
npm run build
npm test
./build.sh        # packages build/cursor-agent-<version>.vsix
```

---

## Contributing

Issues and pull requests are welcome at [LionLin2003/vscode-cursor-agent](https://github.com/LionLin2003/vscode-cursor-agent). Before opening a pull request, run `npm run typecheck` and `npm test`.

This project is a fork of [erebusdev/vscode-cursor-agent](https://github.com/erebusdev/vscode-cursor-agent).
