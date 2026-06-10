# `#agent` sticky agent picker — Copilot CLI extension

## Goal
Replicate the CLI's `/agent` sticky-agent behavior inside the Copilot **app** by intercepting a
`#agent <name>` directive via a user-scoped CLI extension hook (`onUserPromptSubmitted`) and
performing a **real agent switch** through the runtime's agent RPC.

## RESOLVED: persona injection vs. true switching → TRUE SWITCHING
Earlier prototype injected the agent's persona as hidden context (behavior steering only — could
NOT change tools or model). The SDK actually DOES expose an experimental agent RPC namespace, so the
extension was rewritten to use it. This is genuine `/agent` parity (real tool allowlist + model swap).

## Real agent API (verified in SDK `generated/rpc.d.ts`, `@experimental`)
- `session.rpc.agent.list(): { agents: AgentInfo[] }`
- `session.rpc.agent.getCurrent(): { agent?: AgentInfo | null }` (null = default agent)
- `session.rpc.agent.select({ name }): { agent: AgentInfo }` — "Selects a custom agent for **subsequent turns**."
- `session.rpc.agent.deselect(): void` — back to default
- `session.rpc.agent.reload(): { agents: AgentInfo[] }`
- `AgentInfo`: `name, displayName, description, path?, id, source?, userInvocable?, tools?: string[], model?: string`

## Key design decisions (current extension.mjs)
- **Runtime `list()` is the authoritative agent source** (replaces file-based discovery) — matches `/agent`.
- **Plain turns (no directive) → do NOTHING.** Runtime owns stickiness; hook must not interfere.
- **`#agent <name>` is switch-only.** Because `select` applies to *subsequent* turns, the directive
  turn confirms the switch; the user's NEXT message runs as the real agent. Same-line task → ask resend.
- **`list` re-scans first.** `list()` returns the runtime's session-start cache, so the list handler
  does a best-effort `reload()` before listing (failure is ignored) — newly added agents always show.
- **Re-entrancy guard:** every RPC wrapped in `withTimeout(…, 6000ms)` so a stall fails gracefully.
- **`select` fallback:** try `{ name }`; on error retry `{ name: id }` if id !== name.
- **`hasAgentRpc()` guard:** older runtime without the API → friendly "needs newer Copilot" message.
- Subagent-only agents (`userInvocable: false`) filtered out of selection/list.

## Verified
- [x] Extension reloads clean (not "failed"); `copilot-agent-picker.log` `loaded` event has **`agentRpc:true`**
      → the app runtime DOES expose the experimental agent RPC.
- [x] Persona-injection prototype fully validated end-to-end in prior segments (hook fires from app,
      directive parsing robust against app-injected context blocks).

## Directives
- `#agent <name>` → switch (effective next turn)
- `#agent` (bare) / `#agent list` → list selectable agents (re-scans disk first)
- `#agent status` → report current agent
- `#agent clear` → revert to the default agent

## Parser robustness (retained from prototype)
App appends hidden context blocks to the prompt (`<canvas-context>`, `<current_datetime>`,
`<system_reminder>`, …). 3-layer defense: `stripAppContext` (line/block-aware), `cutAtAppTag`
(inline), `isEffectivelyEmptyTask` (unknown future tags). `APP_BLOCK_TAGS` drives all three.

## Constraints (still apply)
- File MUST be `extension.mjs`; `import { joinSession } from "@github/copilot-sdk/extension"`.
- NEVER `console.log` (stdout = JSON-RPC) → `session.log()` + file-based `appendLog`.
- Extension reloads on `/clear` (in-memory lost — fine, runtime owns selection now).
- Windows `import.meta.url` pathname fix: `.replace(/^\/([A-Za-z]:)/, "$1")`.

## Output channel — RESOLVED: `replyVerbatim` (modifiedPrompt), NOT suppressOutput
Two empirical findings drove this:
1. A `UserPromptSubmitted` hook **cannot abort the model turn** — `UserPromptSubmittedHookOutput`
   only has `{ modifiedPrompt?, additionalContext?, suppressOutput? }`. The model turn always happens.
2. `session.log()` lines are **NOT rendered in the desktop app chat**, and `suppressOutput:true` does
   NOT stop the model reply. So `session.log + suppressOutput` = invisible status + rambling model.
Fix: `replyVerbatim(text)` returns `{ modifiedPrompt: "<strict no-analysis/no-tools/no-commentary
instruction>\n\n" + text }`. The unavoidable model turn becomes a single bounded status line.
ALL handlers (list, status, clear, set-success, set-unknown, set-error, no_agent_rpc) use it.

## Exception / failure behavior — fail-open
- Whole hook body is wrapped in `try/catch`; on throw → log `hook_error` + bare `return` (no output
  object) → runtime proceeds with the user's ORIGINAL prompt unchanged. Turn never breaks.
- Both `listRuntimeAgents()` calls (list + set) are now individually guarded → friendly
  "couldn't reach the agent API" verbatim message instead of falling through to fail-open.

## Performance / extensibility refactor
Hook fires on every prompt, so the no-directive path is tightened:
- **Fast-path gate** in `parseDirective`: `if (prompt.indexOf("#") === -1) return null;` BEFORE
  any strip/split/regex. (Can't `startsWith("#")` — app prepends hidden context blocks.)
- **Logging gate**: the per-prompt `appendLog` is INSIDE the try, AFTER `if (!directive) return;`.
  Non-directive turns do ZERO disk I/O / allocation.
- **Extensible command dispatch**: generalized regex `/^\s*#([a-z][a-z0-9_]*)\b(.*)$/i` captures the
  command word → `switch(command){ case "agent": parseAgentDirective(...); default: return null }`.
  Unknown `#<command>` passes through untouched. New commands slot in as additional `case`s.

## Q: inline `#agent` autocomplete — ANSWERED: NOT POSSIBLE via extension
Only post-submit hooks exist; none provide as-you-type input suggestions. `onUserPromptSubmitted`
fires AFTER submit. Inline autocomplete is an app-frontend feature, not extension-drivable. Use
`#agent list` to discover names, or file an app feature request.

## Files
- `extension.mjs` — the deliverable (RPC-based agent switching).
- `README.md` — install + usage docs.
- `copilot-agent-picker.log` (gitignored) — runtime diagnostic log written next to the extension.
