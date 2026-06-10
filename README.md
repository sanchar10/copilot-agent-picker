# copilot-agent-picker

A user-scoped **GitHub Copilot CLI extension** that brings the CLI's `/agent`
sticky-agent behavior to the **Copilot desktop app** (and the CLI) via a `#agent`
chat directive.

Custom agents are one of Copilot's most useful features — each bundles its own
**system prompt, tool allowlist, and model**, so you can keep a focused set of personas
(a tightly-scoped `security-review` agent, a read-only `research` agent, a heavyweight `architect` on a bigger model) and reach for the right one per task. The **CLI** lets you pick one with `/agent` and it stays active for the whole session, but the **desktop app** has no equivalent — no menu, command, or shortcut — so app users are silently locked to the default agent and can't reach the custom agents they've defined. You can still *ask* the app to "use the docs agent" in plain language, but that's not deterministic: the model may partially adopt it, or quietly drift back to the default after a few turns.

This extension closes that gap. It intercepts a leading `#agent <name>` directive on the
`onUserPromptSubmitted` hook and calls the session's agent RPC to switch agents **for real** —
the runtime swaps the agent's actual tool allowlist and model, exactly like the CLI's
`/agent`. The selection stays sticky until you change or clear it.

> **Real switching.** This uses the runtime's agent RPC
> (`session.rpc.agent.select / deselect / list / getCurrent / reload`), so the swap is a genuine change of the agent's **tool allowlist + model**. The runtime keeps the selection sticky until cleared.

---

## Install

Pick whichever method is easiest for you; all of them just land `extension.mjs` in a discovery folder named `copilot-agent-picker`.

### Option A — single-file download (no git, no copy) ⭐ easiest

```powershell
# Windows (PowerShell)
$dir = "$env:USERPROFILE\.copilot\extensions\copilot-agent-picker"
New-Item -ItemType Directory -Force $dir | Out-Null
Invoke-WebRequest -UseBasicParsing https://raw.githubusercontent.com/sanchar10/copilot-agent-picker/main/extension.mjs -OutFile "$dir\extension.mjs"
```

```bash
# macOS / Linux
mkdir -p ~/.copilot/extensions/copilot-agent-picker
curl -fsSL https://raw.githubusercontent.com/sanchar10/copilot-agent-picker/main/extension.mjs \
  -o ~/.copilot/extensions/copilot-agent-picker/extension.mjs
```


### Option B — ask Copilot to install it (app, zero shell)

The Copilot app can install an extension from a repo for you. In chat, ask:

> Install the Copilot extension from `https://github.com/sanchar10/copilot-agent-picker`
> and name it `copilot-agent-picker`.

> The discovery folder **must** contain `extension.mjs` directly
> (`.../extensions/copilot-agent-picker/extension.mjs`). The folder name becomes the
> extension id and is otherwise cosmetic — it does **not** affect the `#agent` directive.

### Activate & verify

1. Restart the Copilot app.
2. In chat, type `#agent list` — you should see your available agents.
3. `#agent <name>` switches; `#agent clear` reverts.

---

## Usage (type these as a normal chat message)

| Command | Effect |
|---|---|
| `#agent <name>` | Switch to `<name>`. Takes effect from your **next** message. |
| `#agent status` | Report which agent is currently active. |
| `#agent list` (or bare `#agent`) | List selectable agents (name, model). Re-scans agent definitions from disk first, so newly added agents always show up. |
| `#agent clear` | Revert to the default agent. |

The directive must be the **first non-whitespace text** on its line.

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
- **Logging only on directive turns.** Normal messages write nothing to `copilot-agent-picker.log`.
- **Extensible command dispatch.** The parser captures the command word (`#<command>`) and
  switches on it. Today only `agent` is registered; unknown `#<command>` directives pass
  through unchanged. Adding a future command is a new `case` — the fast path is untouched.

## Agent sources

Agents are discovered by the runtime (same as the CLI):

- User: `~/.copilot/agents/<name>.md` or `<name>.agent.md`
- Project: `<git-root>/.github/agents/<name>.md` or `<name>.agent.md`

`#agent list` reflects exactly what the runtime exposes. Subagent-only entries
(`userInvocable: false`) are hidden from selection.

## Files this extension writes

- `copilot-agent-picker.log` — diagnostic log written **inside the extension's own folder**
  (`.../extensions/copilot-agent-picker/copilot-agent-picker.log`); truncated prompt preview only.
  Written **only on directive turns** (and on errors); normal messages log nothing. Records
  each `select`/`deselect`/`list` result, used to confirm app-originated turns reach the hook
  and that switches apply.

## Limitations

- **Each `#agent` directive costs one chat turn.** A `UserPromptSubmitted` hook can't
  abort the model turn, so the directive can't be handled silently — it's rewritten into a
  single bounded confirmation line (see *Output & failure behavior*), which stays in
  your conversation history. The footprint is small but not zero — a ~70-token preamble plus the reply. 
  Switch/status/clear are a single line (~15–30 tokens); `#agent list` echoes one line per agent, ~15 tokens per agent.
  
  Prefer switching at a **task boundary** (start of a task, or right after `/clear`) to keep an in-progress thread clean, 
  since the selection is sticky anyway.

## Requirements

- A Copilot version whose runtime exposes the experimental agent RPC. If it doesn't,
  `#agent` replies with a friendly "this runtime doesn't expose the agent switching API"
  message instead of failing silently.
- No external dependencies; pure ESM (`extension.mjs`). The `@github/copilot-sdk` import is
  provided by the CLI at runtime.

## License

MIT — see [LICENSE](LICENSE).
