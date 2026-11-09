# claude-api-ui

A small local web UI for [Claude Code](https://code.claude.com) in headless mode (`claude -p`),
billed to your **Anthropic API key** (Console credits) instead of a Claude subscription.

It gives you a chat window in the browser that streams Claude's answers, tool calls and
results live, resumes earlier sessions, and shows what each prompt cost. It has no
dependencies: one Node.js script and one HTML page.

## Requirements

- **Node.js 18+**
- **Claude Code** installed with `claude` on your `PATH`, or set `CLAUDE_BIN=/path/to/claude`.
- An **Anthropic API key** from the [Claude Console](https://platform.claude.com).
- macOS or Linux. Windows is untested.

## Install

```sh
npm install -g claude-api-ui
```

Or run it without installing: `npx claude-api-ui`.

From source:

```sh
git clone https://github.com/petertulala/claude-api-ui.git
cd claude-api-ui
npm link          # puts `claude-api-ui` on your PATH; or run `node cli.js`
```

## Set your API key

The app looks for `ANTHROPIC_API_KEY` in these places, in order:

1. The environment: `export ANTHROPIC_API_KEY=sk-ant-...`
2. The `env` section of `~/.claude/settings.json`, which Claude Code applies itself:
   ```json
   { "env": { "ANTHROPIC_API_KEY": "sk-ant-..." } }
   ```
3. A key file:
   ```sh
   mkdir -p ~/.config/claude-api-ui
   printf '%s' 'sk-ant-...' > ~/.config/claude-api-ui/api_key
   chmod 600 ~/.config/claude-api-ui/api_key
   ```

An `apiKeyHelper` in `~/.claude/settings.json` is accepted too.

## Run

Run it from the project directory you want Claude to work in:

```sh
cd ~/path/to/your/project
claude-api-ui
```

It prints a URL like `http://127.0.0.1:8765/?t=<token>` and opens it in your browser.

| Option         | Meaning                                                  |
| -------------- | -------------------------------------------------------- |
| `--cwd DIR`    | Default working directory (default: current directory)   |
| `--port N`     | Port to listen on (default 8765, or the next free port)  |
| `--no-browser` | Don't open the browser, just print the URL               |
| `--version`    | Print the version                                        |

## Using it

Each prompt runs:

    claude -p --output-format stream-json --verbose --include-partial-messages \
           [--resume <session-id>] [--model …] [--effort …] [--permission-mode …] \
           [--allowedTools …] [--max-budget-usd …] [extra args]  < prompt

The exact command is shown above each answer.

**Keys:** Enter sends · Shift+Enter adds a newline · Esc stops the run (kills the whole process
group, including tools) · Cmd/Ctrl+K starts a new session.

### Sessions

- The first prompt starts a new session. Each later prompt resumes that session by ID
  (`--resume`), so other Claude sessions in the same directory don't interfere.
- The **working directory** is locked once a session starts. To work somewhere else, click
  **New** and change the path.
- The dropdown lists the sessions Claude Code stored for the working directory
  (`~/.claude/projects/<dir>/`), including ones started with `claude -p` in a terminal.
  Picking one replays its history and continues it.
- Settings: **--continue when new** uses `--continue` for the first prompt;
  **fork on resume** adds `--fork-session`.

### Billing and cost

- The **auth** badge shows the `apiKeySource` Claude reports when each run starts. Green
  `ANTHROPIC_API_KEY` means the run is billed to your API key.
- **Require API key** (Settings, on by default) refuses to start without a key and stops any run
  that would be billed some other way, such as a logged-in subscription.
- **Max $/prompt** maps to `--max-budget-usd`.
- Each answer shows the cost of that prompt alone. When `claude` resumes the session it saved
  last, it restores that session's cost (`lastCost` in `~/.claude.json`), so `total_cost_usd`
  becomes the session total. The server subtracts what was saved before the run. The session
  total is shown in brackets.
- The **spent** badge adds up the cost of the prompts run in the current browser tab. It is not
  your account balance; the API doesn't expose that, so **balance ↗** links to the Console
  billing page.

### Permissions

`claude -p` can't ask for approval, so any tool that isn't pre-approved is **denied**, and the
result line lists the denied tools. Allow them under Settings with **Allowed tools**
(e.g. `Bash(git *) Edit`) or a **Permissions** mode (`acceptEdits`, `auto`,
`bypassPermissions`), then ask again.

### Browser

**Browser** (Settings) gives Claude a web browser. The tools of the chosen browser are
pre-allowed, because `-p` can't ask for approval:

- **Claude in Chrome**: passes `--chrome` and drives your own Chrome, with your logins,
  through the Claude in Chrome extension. The extension must be installed and signed in.
  Its site permissions are still asked for in Chrome itself.
- **Playwright MCP**: loads [`@playwright/mcp`](https://github.com/microsoft/playwright-mcp)
  via `npx` (Node 18+). It opens its own Chrome window with a separate profile, so you start
  logged out of everything. The headless variant shows no window.

Either way, the model's tokens are billed like any other run. Screenshots and page snapshots
are input tokens, so browser-heavy prompts cost more; use **Max $/prompt** to cap them.

### Other settings

Model, effort, a raw-event view for debugging, and **Extra args** for any other `claude` flag.
Settings are kept in your browser's local storage.

## Security

- The server listens on `127.0.0.1` only.
- Every request needs a random token generated at each launch. It is part of the printed URL,
  so other web pages can't drive the app.
- It runs `claude` with your user's permissions in the chosen directory, with whatever tool
  permissions you allow. Don't expose the port to other machines.
- Your API key is never sent to the browser. The page only learns whether a key was found.

## License

[MIT](LICENSE)
