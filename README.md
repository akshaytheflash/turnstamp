# turnstamp

Prove what your AI coding agent actually did, and which files a human touched.

Your agent says it changed three files. turnstamp tells you which files the agent
wrote, and flags every file a human changed after the agent said it was done.

```
npm install -g turnstamp
turnstamp install            # wires up OpenCode and Claude Code
turnstamp verify
```

Works with **OpenCode** and **Claude Code**, using each tool's own hooks. No
filesystem watching and no guessing, because the agent reports each file it
touches at the moment it touches it.

## Why

A diff shows the end state of a file. It does not tell you who wrote it, or
whether something changed after the agent finished.

turnstamp records the agent's tool calls as they happen. Before the call it
hashes the files the call is about to touch, after the call it hashes them
again. That pair is the agent's own account of what it did, and it goes into a
hash chain that breaks the moment anyone edits history.

Anything the chain does not cover is not the agent. That is how a human edit is
told apart from an agent edit without guessing.

## Install

```
npm install -g turnstamp
cd your-project
turnstamp install
```

That writes:

- `.opencode/plugins/turnstamp/index.js` for OpenCode
- `.claude/settings.json` hook entries for Claude Code, merged with whatever is already there

Start a new agent session and the hooks are live. Use `turnstamp install opencode`
or `turnstamp install claude` to do just one. Add `--scope user` to install for
every project instead of just this one.

### What gets recorded

| Agent | Tool | Recorded as |
| --- | --- | --- |
| OpenCode | `write`, `edit`, `patch` | file event with before and after hashes |
| OpenCode | `shell` | call event with the command, since the files cannot be known up front |
| Claude Code | `Write`, `Edit`, `MultiEdit`, `NotebookEdit` | file event with before and after hashes |
| Claude Code | `Bash` | call event with the command |

## Commands

| Command | What it does |
| --- | --- |
| `turnstamp install [agent]` | Wire up the hooks, create the ledger |
| `turnstamp verify [--staged]` | Check the chain and say who changed what. `--staged` judges only what git is about to commit |
| `turnstamp log` | Read the ledger back, optionally `--turn N` |
| `turnstamp stamp` | Manual snapshot, for when no hook is installed |
| `turnstamp event --json '{...}'` | Record one event from your own tooling |

### verify

```
ledger   .turnstamp/ledger.jsonl
entries  14
head     40af85f1ae3ce639
chain    intact
files    every file matches what the agent recorded
```

Exit code is 0 when everything checks out and 1 when something does not, so it
works as a CI gate or a pre-commit hook.

Use `--staged` in a pre-commit hook. It still checks the whole chain, but it
only fails on drift in the paths you are committing, so a file you edited and
never staged does not block the commit.

```
#!/bin/sh
turnstamp verify --staged
```

When a human edits a file the agent wrote:

```
chain    intact
files    changed with no agent call behind them
  hello.txt: last written by write, now 2a688f29a91d0f54...
```

When someone edits the ledger itself:

```
chain    BROKEN
  entry 6: digest - content changed after it was stamped
```

## What it skips

`node_modules`, `.git`, `dist`, `build`, `target`, `.venv` and `__pycache__` are
always skipped. For the rest, drop a `.turnstampignore` at the root. The syntax
is gitignore shaped:

```
# generated, never worth hashing
.next/
coverage/
*.lock
# a single deep file
packages/app/dist/bundle.js
```

Patterns with no slash match that name at any depth, a trailing slash matches
directories only. Add `.turnstampignore` itself and the ledger to your git
history so the record travels with the code.

## What it catches

- a file rewritten after the agent said it was done
- an agent claiming a write that never landed on disk
- an entry edited to hide a file
- an entry deleted from the middle
- a careful forger who fixes one digest but not the link to the next entry

## What it does not do

It does not stop an agent from doing something, it records what happened so you
can check afterwards. A shell command is recorded as a call, not as a list of
files, because there is no way to know what a command will touch before it runs.

It also cannot prove anything against someone who deletes the whole ledger and
starts over. Signing the head with a key is the next step, not something 0.1.0
does.

## Library

The CLI is a thin wrapper. Everything is exported.

```js
import { appendEvent, verifyEntries, readLedger, ledgerPath } from "turnstamp";

const file = ledgerPath(process.cwd());
appendEvent(file, {
  actor: "agent",
  kind: "file",
  tool: "custom",
  action: "write",
  target: "src/app.js",
  detail: "sha256 of the file",
});

const report = verifyEntries(readLedger(file));
console.log(report.ok, report.problems);
```

The OpenCode plugin lives at `turnstamp/opencode` if you would rather import it
directly than use the installer.

## Ledger format

One JSON object per line in `.turnstamp/ledger.jsonl`. Fixed key order, so the
hash is stable across machines and Node versions.

```json
{
  "schema": 2,
  "seq": 2,
  "at": "2026-11-16T14:20:18.417Z",
  "turn": null,
  "actor": "opencode",
  "kind": "file",
  "session": "ses_abc",
  "call": "call_def",
  "tool": "write",
  "action": "write",
  "target": "hello.txt",
  "before": "missing",
  "detail": "40af85f1ae3ce639...",
  "prev": "cab1073cf729ddf1...",
  "chain": "8a1b9b0d0e6d0b4b..."
}
```

`prev` is the previous entry's `chain`. The first entry points at 64 zeroes.
`detail` is the hash after the call, `before` is the hash before it. `missing`
means the file did not exist.

Commit the ledger if you want other people to be able to check your work. It is
a record, not a secret.

## Licence

MIT
