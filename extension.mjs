// Extension: agent-picker
// Brings the CLI's /agent sticky-agent behavior to the Copilot app (and CLI) via a
// `#agent <name>` chat directive intercepted on the onUserPromptSubmitted hook.
//
// Approach: REAL agent switching. We call the session's experimental agent RPC
// (session.rpc.agent.select / deselect / list / getCurrent / reload) so the runtime
// swaps the agent's actual tool allowlist + model — exactly like the CLI's /agent.
// The runtime owns stickiness, so plain turns need NO hook action: once an agent is
// selected it stays active for subsequent turns until changed or cleared.
//
// Timing note: agent.select applies to "subsequent turns". So the turn that carries
// the `#agent <name>` directive still runs as the previous/default agent (we use it
// only to confirm the switch). From the user's NEXT message on, the real agent runs.

import { joinSession } from "@github/copilot-sdk/extension";
import fs from "node:fs";
import path from "node:path";

// --- Paths -------------------------------------------------------------------

const EXT_DIR = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const LOG_FILE = path.join(EXT_DIR, "agent-picker.log");

const MAX_PROMPT_PREVIEW = 90; // chars logged (privacy: never log full prompt)
const RPC_TIMEOUT_MS = 6000; // guard against a hung RPC freezing the user's turn

// --- Diagnostic log (file-based; survives /clear; confirms hook fires) -------

function appendLog(obj) {
    try {
        const line = JSON.stringify({ t: new Date().toISOString(), pid: process.pid, ...obj }) + "\n";
        fs.appendFileSync(LOG_FILE, line);
    } catch {
        // never let logging break a turn
    }
}

// Reject a promise if it doesn't settle in time — calling back into the runtime RPC
// from inside a runtime-invoked hook is re-entrant; a timeout keeps a stall from
// hanging the turn (we then degrade gracefully).
function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// --- Directive parsing -------------------------------------------------------

// The app injects hidden context blocks into the prompt the hook receives — e.g.
// <current_datetime>…</current_datetime>, <canvas-context>…</canvas-context>,
// <system_reminder>…</system_reminder>. They can be prepended OR appended and would
// otherwise be mis-parsed as the user's task. We defend in three layers:
//   1. stripAppContext: drop these blocks when a known tag opens at the START of a line.
//   2. cutAtAppTag: cut the directive's same-line remainder at the first inline app tag.
//   3. isEffectivelyEmptyTask: for UNKNOWN future wrapper tags, treat a "task" that is
//      only tag lines / metadata bullets as empty.
const APP_BLOCK_TAGS = [
    "current_datetime",
    "canvas-context",
    "system_reminder",
    "system-reminder",
    "system_notification",
    "system-notification",
];
const APP_TAG_SET = new Set(APP_BLOCK_TAGS);
const APP_TAG_INLINE_RE = new RegExp("<(?:" + APP_BLOCK_TAGS.join("|") + ")\\b", "i");

function stripAppContext(prompt) {
    const lines = prompt.split(/\r?\n/);
    const out = [];
    let waitingFor = null; // closing tag name we're skipping toward
    for (const line of lines) {
        const trimmed = line.trim();
        if (waitingFor) {
            if (trimmed === `</${waitingFor}>` || trimmed.endsWith(`</${waitingFor}>`)) {
                waitingFor = null;
            }
            continue;
        }
        const open = trimmed.match(/^<([a-z0-9_-]+)>/i);
        if (open && APP_TAG_SET.has(open[1].toLowerCase())) {
            const tag = open[1];
            if (trimmed.includes(`</${tag}>`)) continue; // single-line block
            waitingFor = tag; // multi-line block: skip until close (or EOF)
            continue;
        }
        out.push(line);
    }
    return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function cutAtAppTag(s) {
    const m = s.match(APP_TAG_INLINE_RE);
    return m ? s.slice(0, m.index).trim() : s;
}

function isEffectivelyEmptyTask(task) {
    if (!task || !task.trim()) return true;
    const residual = task
        .split(/\r?\n/)
        .filter((l) => {
            const t = l.trim();
            if (!t) return false;
            if (/^<\/?[a-z0-9_-]+(\s[^>]*)?>$/i.test(t)) return false; // standalone tag line
            if (/^-\s+[a-z0-9_]+=/i.test(t)) return false; // metadata bullet, e.g. - name="plan"
            return true;
        })
        .join("")
        .trim();
    return residual.length === 0;
}

// Returns null if the message is not a recognized `#<command>` directive,
// otherwise a directive object. Today only `#agent` is registered:
//   { kind: "set", name, task } | { kind: "clear" } | { kind: "status" }
//   { kind: "list" } | { kind: "reload" }
//
// This runs on EVERY prompt, so the no-directive path must stay cheap. A
// directive always contains a '#'. We can't use startsWith() because the app
// prepends hidden context blocks (<current_datetime>, <canvas-context>, …)
// ahead of the user's text — a real `#agent` line rarely sits at index 0. But
// if there's no '#' ANYWHERE, it can't be a directive: bail after one cheap
// scan, before any line-splitting / stripping / regex.
function parseDirective(prompt) {
    if (typeof prompt !== "string") return null;
    if (prompt.indexOf("#") === -1) return null; // fast path: normal prose exits here

    const clean = stripAppContext(prompt);
    const lines = clean.split(/\r?\n/);

    // The directive must be the FIRST non-empty line the user typed. A `#agent`
    // mention anywhere later (or mid-sentence in a normal message) must NOT trigger
    // a switch — only an intentional, leading `#<command> …` does.
    let idx = -1;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() === "") continue; // skip leading blank lines
        idx = i;
        break;
    }
    if (idx === -1) return null;

    // Generic directive shape: #<command> <args…>. Capturing the command word
    // (instead of hardcoding "agent") keeps the door open for future commands —
    // add a case below and the fast path above is untouched.
    const m = lines[idx].match(/^\s*#([a-z][a-z0-9_]*)\b(.*)$/i);
    if (!m) return null; // first content line isn't a `#<command>` directive

    const command = m[1].toLowerCase();
    const args = m[2].trim();

    switch (command) {
        case "agent":
            return parseAgentDirective(args, lines, idx);
        default:
            return null; // unknown #command → leave the prompt untouched
    }
}

// Arg parsing for the `#agent` command. Receives the text after `#agent`, plus
// the stripped line array + the directive line index for multi-line tasks.
function parseAgentDirective(args, lines, idx) {
    // Bare `#agent` → list the agents (with the active one marked). It reads as
    // "show me the agents" and is the natural discovery entry point. Use
    // `#agent status` for a current-only answer.
    if (args === "") return { kind: "list" };

    const tokens = args.split(/\s+/);
    const sub = tokens[0].toLowerCase();

    if (["clear", "off", "none", "remove", "reset", "default"].includes(sub)) return { kind: "clear" };
    if (["status", "current", "who"].includes(sub)) return { kind: "status" };
    if (["list", "agents", "ls"].includes(sub)) return { kind: "list" };
    if (["reload", "refresh"].includes(sub)) return { kind: "reload" };

    // otherwise first token is the agent name; remainder (+ later lines) is the task
    const name = tokens[0];
    const sameLineRest = cutAtAppTag(args.slice(tokens[0].length).trim());
    const restLines = lines.slice(idx + 1).join("\n").trim();
    let task = [sameLineRest, restLines].filter((s) => s && s.trim()).join("\n").trim();
    if (isEffectivelyEmptyTask(task)) task = "";
    return { kind: "set", name, task };
}

function preview(s) {
    if (typeof s !== "string") return "";
    const oneLine = s.replace(/\s+/g, " ").trim();
    return oneLine.length > MAX_PROMPT_PREVIEW ? oneLine.slice(0, MAX_PROMPT_PREVIEW) + "…" : oneLine;
}

// --- Runtime agent helpers (authoritative source = the session RPC) ----------

function hasAgentRpc() {
    try {
        return !!(session && session.rpc && session.rpc.agent && typeof session.rpc.agent.select === "function");
    } catch {
        return false;
    }
}

async function listRuntimeAgents() {
    const res = await withTimeout(session.rpc.agent.list(), RPC_TIMEOUT_MS, "agent.list");
    return (res && Array.isArray(res.agents)) ? res.agents : [];
}

// Hide subagent-only entries (userInvocable === false) from user selection.
function selectableAgents(agents) {
    return agents.filter((a) => a && a.userInvocable !== false);
}

function describeAgent(a) {
    const dn = a.displayName && a.displayName !== a.name ? ` — ${a.displayName}` : "";
    const model = a.model ? ` [model: ${a.model}]` : "";
    return `- ${a.name}${dn}${model}`;
}

function resolveRuntimeAgent(name, agents) {
    if (!name) return null;
    const w = String(name).toLowerCase();
    return (
        agents.find((a) => a.name && a.name.toLowerCase() === w) ||
        agents.find((a) => a.displayName && a.displayName.toLowerCase() === w) ||
        agents.find((a) => a.id && a.id.toLowerCase() === w) ||
        null
    );
}

// --- User-facing reply -------------------------------------------------------
// A UserPromptSubmitted hook cannot abort the model turn, and the desktop app
// does NOT surface session.log() lines in the chat. The model's reply is the
// only channel the user reliably sees, so feed the model a strict instruction
// to echo our status text verbatim — short, deterministic, no rambling, no
// leaked reasoning. This is also the minimum-pollution option: the turn happens
// regardless; this just bounds what the model says.
function replyVerbatim(text) {
    return {
        modifiedPrompt:
            "A local CLI extension has already fully handled the user's `#agent` command. " +
            "Do NOT analyze it, do NOT call any tools, do NOT add commentary, preamble, or follow-up. " +
            "Output the following message to the user verbatim and output nothing else:\n\n" +
            text,
    };
}

// --- Join session ------------------------------------------------------------

const session = await joinSession({
    tools: [],
    hooks: {
        onSessionStart: async (input, invocation) => {
            appendLog({
                ev: "session_start",
                sessionId: invocation && invocation.sessionId,
                source: input && input.source,
                agentRpc: hasAgentRpc(),
            });
        },

        onUserPromptSubmitted: async (input, invocation) => {
            const sessionId = (invocation && invocation.sessionId) || "unknown";
            const prompt = (input && input.prompt) || "";

            try {
                const directive = parseDirective(prompt);

                // No directive → do NOTHING (and log NOTHING). The runtime keeps the
                // selected agent sticky on its own; normal turns must stay zero-cost
                // (no disk I/O, no preview allocation).
                if (!directive) return;

                // Directive turn — now a diagnostic line is worth the write.
                appendLog({ ev: "prompt", sessionId, kind: directive.kind, preview: preview(prompt) });

                // Every directive below needs the agent RPC.
                if (!hasAgentRpc()) {
                    appendLog({ ev: "no_agent_rpc", sessionId, kind: directive.kind });
                    return replyVerbatim("⚠ #agent: this runtime doesn't expose the agent switching API. You may need a newer Copilot version.");
                }

                // --- list -------------------------------------------------------
                if (directive.kind === "list") {
                    let agents;
                    try {
                        agents = selectableAgents(await listRuntimeAgents());
                    } catch (e) {
                        appendLog({ ev: "list_error", sessionId, msg: String(e && e.message) });
                        return replyVerbatim(`⚠ #agent: couldn't reach the agent API to list agents (${String(e && e.message)}). Try again in a moment.`);
                    }
                    // Mark the active agent so a bare `#agent` answers both
                    // "what can I pick" and "what's active now".
                    let curName = null;
                    try {
                        const r = await withTimeout(session.rpc.agent.getCurrent(), RPC_TIMEOUT_MS, "agent.getCurrent");
                        curName = r && r.agent && r.agent.name;
                    } catch (e) {
                        appendLog({ ev: "list_current_error", sessionId, msg: String(e && e.message) });
                    }
                    appendLog({ ev: "list", sessionId, count: agents.length, current: curName });
                    const lines = agents
                        .map((a) => `${describeAgent(a)}${a.name === curName ? "  ← active" : ""}`)
                        .join("\n");
                    const curLabel = curName ? `the "${curName}" agent` : "the default agent";
                    return replyVerbatim(
                        `🎭 #agent available agents (active: ${curLabel}):\n${lines || "(none found)"}\n` +
                        `Activate one with "#agent <name>" · revert with "#agent clear".`
                    );
                }

                // --- status -----------------------------------------------------
                if (directive.kind === "status") {
                    let cur = null;
                    try {
                        const r = await withTimeout(session.rpc.agent.getCurrent(), RPC_TIMEOUT_MS, "agent.getCurrent");
                        cur = r && r.agent;
                    } catch (e) {
                        appendLog({ ev: "status_error", sessionId, msg: String(e && e.message) });
                    }
                    appendLog({ ev: "status", sessionId, agent: cur ? cur.name : null });
                    const label = cur
                        ? `the "${cur.name}" agent${cur.model ? ` (model: ${cur.model})` : ""}`
                        : "the default agent";
                    return replyVerbatim(`🎭 #agent: currently using ${label}.  "#agent list" shows options · "#agent <name>" switches.`);
                }

                // --- clear / deselect -------------------------------------------
                if (directive.kind === "clear") {
                    let ok = true;
                    let errMsg = null;
                    try {
                        await withTimeout(session.rpc.agent.deselect(), RPC_TIMEOUT_MS, "agent.deselect");
                    } catch (e) {
                        ok = false;
                        errMsg = String(e && e.message);
                    }
                    appendLog({ ev: "clear", sessionId, ok, err: errMsg });
                    return replyVerbatim(ok ? "🧹 #agent: reverted to the default agent (from your next message)." : `⚠ #agent: clear failed (${errMsg}).`);
                }

                // --- reload -----------------------------------------------------
                if (directive.kind === "reload") {
                    let count = 0;
                    let errMsg = null;
                    try {
                        const r = await withTimeout(session.rpc.agent.reload(), RPC_TIMEOUT_MS, "agent.reload");
                        count = (r && Array.isArray(r.agents)) ? r.agents.length : 0;
                    } catch (e) {
                        errMsg = String(e && e.message);
                    }
                    appendLog({ ev: "reload", sessionId, count, err: errMsg });
                    return replyVerbatim(errMsg ? `⚠ #agent: reload failed (${errMsg}).` : `🔄 #agent: reloaded ${count} agent definition(s).`);
                }

                // --- set (switch) -----------------------------------------------
                let choosable;
                try {
                    choosable = selectableAgents(await listRuntimeAgents());
                } catch (e) {
                    appendLog({ ev: "set_list_error", sessionId, name: directive.name, msg: String(e && e.message) });
                    return replyVerbatim(`⚠ #agent: couldn't reach the agent API to switch to "${directive.name}" (${String(e && e.message)}). Try again in a moment.`);
                }
                const match = resolveRuntimeAgent(directive.name, choosable);
                if (!match) {
                    const names = choosable.map((a) => a.name).join(", ");
                    appendLog({ ev: "set_unknown", sessionId, name: directive.name });
                    return replyVerbatim(`⚠ #agent: unknown agent "${directive.name}". Available: ${names || "(none)"}.`);
                }

                // Select by name; fall back to id if the runtime keys on id.
                let selected = null;
                let selErr = null;
                try {
                    const r = await withTimeout(session.rpc.agent.select({ name: match.name }), RPC_TIMEOUT_MS, "agent.select");
                    selected = (r && r.agent) || match;
                } catch (e) {
                    selErr = String(e && e.message);
                    if (match.id && match.id !== match.name) {
                        try {
                            const r2 = await withTimeout(session.rpc.agent.select({ name: match.id }), RPC_TIMEOUT_MS, "agent.select(id)");
                            selected = (r2 && r2.agent) || match;
                            selErr = null;
                        } catch (e2) {
                            selErr = String(e2 && e2.message);
                        }
                    }
                }

                if (selErr) {
                    appendLog({ ev: "set_error", sessionId, name: match.name, err: selErr });
                    return replyVerbatim(`⚠ #agent: failed to select "${match.name}" (${selErr}).`);
                }

                appendLog({
                    ev: "set",
                    sessionId,
                    agent: selected.name,
                    model: selected.model || null,
                    tools: Array.isArray(selected.tools) ? selected.tools.length : null,
                    hadTask: !!directive.task,
                });
                const modelNote = selected.model ? ` (model: ${selected.model})` : "";
                const successText = directive.task
                    ? `🎛 #agent: switched to "${selected.name}"${modelNote}. Active from your NEXT message.\n` +
                      `⚠ The rest of your message ("${preview(directive.task)}") was NOT run — resend it as a new message ` +
                      `so "${selected.name}" handles it.`
                    : `🎛 #agent: switched to "${selected.name}"${modelNote}. Active from your next message.`;
                return replyVerbatim(successText);
            } catch (err) {
                appendLog({ ev: "hook_error", sessionId, msg: String(err && err.message), stack: String(err && err.stack) });
                return; // never break the user's turn
            }
        },
    },
});

appendLog({ ev: "loaded", extDir: EXT_DIR, agentRpc: hasAgentRpc() });
await session.log("agent-picker ready — `#agent <name>` to switch · `#agent list` · `#agent status` · `#agent clear`.");
