# agent-picker

A user-scoped **GitHub Copilot CLI extension** that brings the CLI's `/agent`
sticky-agent behavior to the **Copilot desktop app** (and the CLI) via a `#agent`
chat directive.

The Copilot app has no native agent picker. This extension intercepts a leading
`#agent <name>` directive on the `onUserPromptSubmitted` hook and calls the session's
agent RPC to switch agents **for real** — the runtime swaps the agent's actual tool
allowlist and model, exactly like the CLI's `/agent`. The selection stays sticky until
you change or clear it.

> **Real switching, not persona faking.** This uses the runtime's experimental agent RPC
> (`session.rpc.agent.select / deselect / list / getCurrent / reload`), so the swap is a
> genuine change of the agent's **tool allowlist + model**. The runtime keeps the
> selection sticky on its own, so normal turns are passed through untouched.

---

## Install

Copilot CLI auto-discovers any folder that contains an `extension.mjs`. You don't build
or `npm install` anything — the `@github/copilot-sdk` import is resolved automatically.
Just drop this folder into one of the two discovery locations and restart Copilot.

### Option A — user-scoped (recommended: applies to every session)

Copy the `agent-picker` folder into your Copilot extensions directory:

| OS | Destination |
|---|---|
| Windows | `%USERPROFILE%\.copilot\extensions\agent-picker\` |
| macOS / Linux | `~/.copilot/extensions/agent-picker/` |

```bash
# macOS / Linux
git clone <REPO_URL> /tmp/agent-picker
mkdir -p ~/.copilot/extensions
cp -R /tmp/agent-picker ~/.copilot/extensions/agent-picker
```

```powershell
# Windows (PowerShell)
git clone <REPO_URL> $env:TEMP\agent-picker
New-Item -ItemType Directory -Force "$env:USERPROFILE\.copilot\extensions" | Out-Null
Copy-Item -Recurse -Force "$env:TEMP\agent-picker" "$env:USERPROFILE\.copilot\extensions\agent-picker"
```

The installed folder **must** be named so it contains `extension.mjs` directly
(`.../extensions/agent-picker/extension.mjs`). The folder name becomes the extension id.

### Option B — project-scoped (just one repo)

Copy the folder into a repository's `.github/extensions/`:

```
<your-repo>/.github/extensions/agent-picker/extension.mjs
```

The extension is then active only when Copilot runs against that repo.

### Activate & verify

1. Restart the Copilot app (or in the CLI, run `/clear` to reload extensions).
2. In chat, type `#agent list` — you should see your available agents.
3. `#agent <name>` switches; `#agent clear` reverts.

---

## Usage (type these as a normal chat message)

| Command | Effect |
|---|---|
| `#agent <name>` | Switch to `<name>`. Takes effect from your **next** message. |
| `#agent status` (or bare `#agent`) | Report which agent is currently active. |
| `#agent list` (or `#agent agents`) | List selectable agents (name, model). |
| `#agent clear` (or `off` / `none` / `default`) | Revert to the default agent. |
| `#agent reload` | Reload agent definitions from disk. |

The directive must be the **first non-whitespace text** on its line, so `#agent` inside a
code block or mid-paragraph is ignored. The app's hidden context blocks
(`<canvas-context>`, `<current_datetime>`, …) are stripped before parsing.

## Output & failure behavior

- **The reply you see on a directive turn is a single bounded status line.** A
  `UserPromptSubmitted` hook cannot abort the model turn, and the app does **not** render
  `session.log()` lines in chat. So instead of suppressing output, the hook rewrites the
  prompt (`replyVerbatim`) with a strict "echo this one line, no analysis, no tools"
  instruction. The unavoidable model turn becomes the confirmation message.
- **Fail-open.** The entire hook is wrapped in `try/catch`; any error logs `hook_error` and
  falls through with your **original prompt untouched**, so a bug here can never break a turn.
- **Agent-RPC errors are caught** and surfaced as a friendly one-line message rather than
  falling through.

## Performance & extensibility

This hook fires on **every** prompt, so the no-directive path is kept cheap:

- **Fast-path gate:** if the prompt contains no `#` anywhere, it returns immediately — no
  line-splitting, no stripping, no regex, **no logging / disk I/O**. (A plain `startsWith("#")`
  can't be used because the app prepends hidden context blocks ahead of your text, so a real
  `#agent` line rarely sits at character 0.)
- **Logging only on directive turns.** Normal messages write nothing to `agent-picker.log`.
- **Extensible command dispatch.** The parser captures the command word (`#<command>`) and
  switches on it. Today only `agent` is registered; unknown `#<command>` directives pass
  through unchanged. Adding a future command is a new `case` — the fast path is untouched.

### Timing

`agent.select` applies to *subsequent* turns. So the message that carries
`#agent <name>` still runs as the previous/default agent (it just confirms the switch);
from your next message on, the chosen agent — with its own tools and model — handles the
turn. If you append a task on the same line (`#agent foo do X`), resend the task as a new
message so the switched agent processes it.

## Agent sources

Agents are discovered by the runtime (same as the CLI):

- User: `~/.copilot/agents/<name>.md` or `<name>.agent.md`
- Project: `<git-root>/.github/agents/<name>.md` or `<name>.agent.md`

`#agent list` reflects exactly what the runtime exposes. Subagent-only entries
(`userInvocable: false`) are hidden from selection.

## Files this extension writes

- `agent-picker.log` — diagnostic log (truncated prompt preview only). Written **only on
  directive turns** (and on errors); normal messages log nothing. Records each
  `select`/`deselect`/`list` result, used to confirm app-originated turns reach the hook and
  that switches apply. (Git-ignored — never committed.)

## Why not inline `#agent` autocomplete?

The CLI extension hooks only fire **after** a prompt is submitted — there is no
completion/suggestion-provider API for the app's input box. As-you-type `#agent`
autocomplete would have to be a native app frontend feature; an extension can't drive it.
Use `#agent list` to discover names instead.

## Requirements

- A Copilot version whose runtime exposes the experimental agent RPC. If it doesn't,
  `#agent` replies with a friendly "this runtime doesn't expose the agent switching API"
  message instead of failing silently.
- No external dependencies; pure ESM (`extension.mjs`). The `@github/copilot-sdk` import is
  provided by the CLI at runtime.

## For maintainers — distribution

Because installation is just "place the folder in a discovery location," distribution is
simply sharing this repo:

- **Manual:** users `git clone` (or download a release zip) and copy the folder into
  `~/.copilot/extensions/` (user-scoped) or `<repo>/.github/extensions/` (project-scoped),
  then restart Copilot — see [Install](#install) above.
- **Vendor into a team repo:** commit `agent-picker/` under that repo's
  `.github/extensions/` so every teammate working in the repo gets it automatically.

Keep `extension.mjs` at the folder root and don't commit `agent-picker.log` (handled by
`.gitignore`).

## License

MIT — see [LICENSE](LICENSE).
