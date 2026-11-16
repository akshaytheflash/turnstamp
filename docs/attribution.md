# The problem with v0.1.0

The first version hashed the whole tree and could not answer the question that
matters: did the agent or the human change this file?

It guessed. Anything that moved between two manual stamps was blamed on nobody
in particular. A human editing in VS Code while the agent wrote a different file
looked exactly the same as the agent rewriting both.

# What attribution actually takes

The agent has to tell us. Both tools expose a hook at the exact moment a tool
call runs, and that hook carries the tool name and the arguments. That is the
only reliable signal, because it is the agent's own record of what it just did.

A watcher on the filesystem cannot do this. It sees a write and has no idea who
made it.

So the plugin records two things:

1. Before the tool runs, the hash of every file the call is about to touch.
2. After it runs, the hash it left behind.

That gives a pair of states per call, attributed to a tool, a session and a
message. The event is signed the same way as everything else in the chain.

Anything the chain does not cover is, by definition, not the agent. That is how
human edits get distinguished without any guessing: the file check reports each
file as `agent` (matches the last agent write), `human` (does not match), or
`unknown` (no record at all).

# Per tool shape

## OpenCode

Plugin API is V2, from `@opencode/plugin`. The hook is `ctx.tool.hook`:

```ts
interface ToolHooks {
  "execute.before": {
    tool: string;
    sessionID: Session.ID;
    agent: Agent.ID;
    messageID: SessionMessage.ID;
    id: Tool.CallID;
    input: unknown;      // mutable
  };
  "execute.after": { ...same } & (
    | { status: "completed"; result: Tool.Result }
    | { status: "error"; error: Tool.Error }
  );
}
```

Built in tools that touch files: `write`, `edit`, `patch`. Inputs use
`filePath`. `patch` is freeform text using the `*** Update File:` header format,
so paths have to be parsed out of the patch body.

The `shell` tool can also write files, so a shell call is recorded as an event
but not as a file claim.

## Claude Code

Hooks are external processes. `PostToolUse` and `PreToolUse` are configured in
`~/.claude/settings.json` or `.claude/settings.json`, receive JSON on stdin and
communicate by exit code.

The payload carries `session_id`, `transcript_path`, `cwd`, `hook_event_name`,
`tool_name`, `tool_input` and `tool_use_id`.

File tools are `Write`, `Edit`, `MultiEdit` and `NotebookEdit`. Inputs use
`file_path`, always absolute.

A command hook has to be fast, because it runs inline on every tool call. So the
hook script reads stdin, appends one entry and exits. No hashing of the tree and
no network.

# Decisions

- The ledger keeps the same hash chain. Nothing about integrity changes.
- Entries gain `actor` (agent name), `session`, `call`, and `phase`.
- A file entry carries `before` and `after` digests so a replay can prove the
  transition as well as the end state.
- `verify` now classifies drift instead of just reporting it.
- Manual stamps stay, but they are the fallback, not the main path.
