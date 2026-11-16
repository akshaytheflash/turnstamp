# turnstamp

Prove what your AI coding agent actually did.

Your agent says it only changed three files. turnstamp lets you check. It keeps a
tamper evident ledger of every turn: what the tree looked like, what each turn
touched, and a hash chain that breaks the moment someone edits history.

```
npx turnstamp init
npx turnstamp stamp --turn 1 --tool claude
npx turnstamp verify
```

## Why

Coding agents are fast and confident and not always accurate about their own
work. A diff shows you the end state of a file. It does not show you that your
agent read `.env`, ran a script, or quietly rewrote a file two turns after it
said it was done.

turnstamp records the sequence and makes the record hard to fake. Every entry
carries the hash of the entry before it, so deleting or editing one line in the
middle breaks every hash after it.

## Commands

| Command | What it does |
| --- | --- |
| `turnstamp init` | Creates `.turnstamp/ledger.jsonl` |
| `turnstamp stamp` | Records the files that changed since the last stamp |
| `turnstamp event --json '{...}'` | Records one agent event, for hooks |
| `turnstamp verify` | Checks the hash chain and the files on disk |
| `turnstamp log` | Reads the ledger back, optionally `--turn N` |

### stamp

```bash
turnstamp stamp --turn 3 --tool claude --action edit
```

It hashes the tree, compares it to the previous snapshot, and writes one entry
per changed file plus a summary entry. The summary holds the digest of the whole
tree, so you can tell two turns apart without walking every file again.

### event

For agent hooks and wrapper scripts. Feed it whatever your agent gives you.

```bash
turnstamp event --json '{"turn":3,"tool":"claude","action":"bash","target":"npm test","detail":"exit 0"}'
turnstamp event --json '{"turn":3,"tool":"claude","action":"read","target":"src/auth.js"}'
```

### verify

```bash
turnstamp verify
```

```
ledger   .turnstamp/ledger.jsonl
entries  7
head     7d5597b5559bff0a
chain    intact
files    match the last stamp
```

Exit code is 0 when everything checks out and 1 when something does not. Use it
as a CI gate or a pre commit hook.

Two separate things get checked. The chain tells you whether the ledger itself
was edited. The file check tells you whether anything was rewritten after it was
stamped.

```
chain    BROKEN
  entry 6: digest - content changed after it was stamped
files    changed after they were stamped
  src/a.js: stamped 1df3032e75cb45e5..., now 19b1f8a398e0bf0c...
```

## What it does not do

It does not stop an agent from doing something. It records what happened so you
can check afterwards. It also cannot prove anything against someone who deletes
the whole ledger and starts over, which is why a sealed head matters and why the
next version signs the head with a key you keep.

It catches the common cases:

- a file rewritten after the agent said it was done
- an entry edited to hide a file
- an entry deleted from the middle
- a careful forger who fixes the digest but not the link to the next entry

## Library

The CLI is a thin wrapper. Everything is exported if you want it inside your own
tooling.

```js
import { appendEvent, verifyEntries, readLedger, ledgerPath } from "turnstamp";

const file = ledgerPath(process.cwd());
appendEvent(file, { turn: 1, tool: "claude", action: "read", target: "src/app.js" });

const report = verifyEntries(readLedger(file));
console.log(report.ok, report.problems);
```

## Ledger format

One JSON object per line in `.turnstamp/ledger.jsonl`. Fixed key order, so the
hash is stable across machines and Node versions.

```json
{
  "schema": 1,
  "seq": 2,
  "at": "2026-11-16T13:42:59.123Z",
  "turn": 1,
  "tool": "claude",
  "action": "write",
  "target": "src/app.js",
  "detail": "f51105f5972c...",
  "prev": "948bccbeadb7...",
  "chain": "3d1484ea99d5..."
}
```

`prev` is the previous entry's `chain`. The first entry points at 64 zeroes.
`detail` is the file's sha256 for a write, or free text for other events.

Commit the ledger if you want other people to be able to check your work. It is
a record, not a secret.

## Licence

MIT
