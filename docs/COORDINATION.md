# Working two agents in parallel

Status: Draft 0.1
Distribution: Proprietary and confidential

Two agents — Claude Code and Codex — work this repository at the same time to
finish the queue faster. They are not users of the product and this is not a
demonstration of it; it is how the work gets done. Nothing here is a product
surface and nothing here traces to a goal, for the same reason
[CONTRIBUTING.md](../CONTRIBUTING.md) does not.

Parallelism fails in exactly two ways: both agents do the same task, or both
edit the same file. The protocol below prevents the first by claiming and the
second by worktrees plus declared file ownership.

## Identity

Two names, fixed: `claude` and `codex`. Every command carries `--agent <name>`.

## The board

The queue is [ROADMAP.md](ROADMAP.md); the board is who holds what right now.

```sh
node scripts/coord.js status                     # what is open, claimed, done
node scripts/coord.js claim R4 --agent codex \
  --branch feat/r4-auto-freeze \
  --files src/coordination.js,src/server.js      # exclusive; declares ownership
node scripts/coord.js done R4 --agent codex --note "merged"
node scripts/coord.js release R4 --agent codex   # gave up, still open
```

A claim is refused if the item is already held, or if a declared file overlaps
a file another live claim declared. Refusal is the feature: it turns a silent
collision into an error before either agent has written anything.

State lives in `.git/agent-coordination/`, so every worktree of this repository
shares one board and one set of inboxes, and none of it is ever committed.

## Messages

```sh
node scripts/coord.js send --to claude --from codex "R4 needs a db.js hunk" --re R4
node scripts/coord.js read --agent codex            # unread only
node scripts/coord.js read --agent codex --wait     # blocks until one arrives
node scripts/coord.js log --limit 20                # recent coordination events
```

`--wait` blocks and exits on the first message, which is how an agent whose
shell wakes on process exit gets a push rather than a poll.

Say these four things and little else: **I am taking X**, **X is done and
merged**, **I need a file you hold**, **X is blocked because Y**. Design
argument belongs in the code review or an ADR, not in the channel.

## Worktrees

Never two agents in one checkout. Each agent works in its own:

```sh
git worktree add ../ai-cohort-codex -b feat/r4-auto-freeze
```

The main checkout stays with whoever is driving; the second agent gets a
sibling directory. Both see the same board because the board lives in the
shared `.git`.

## Shared files

Three files are chokepoints that both agents will eventually need:

| File | Rule |
| --- | --- |
| `src/db.js` | Schema changes are **append-only new table blocks**. Never restructure an existing block while another claim is live. |
| `docs/API.md` | Add sections; do not reorganize. |
| `docs/ROADMAP.md` | Only the agent finishing an item edits it, and only to move that item. |

Declaring one of these in `--files` locks it for the whole claim, which is
usually too coarse. Prefer to announce the hunk you are adding and keep the
edit small.

## Finishing an item

1. `npm run check` and `npm test` pass on your branch.
2. The definition of done in [CONTRIBUTING.md](../CONTRIBUTING.md) is met — the
   whole checklist, including the docs and the roadmap entry.
3. Rebase on `main`, run the tests again, and merge.
4. `coord.js done <id>` and one message saying so.

If the other agent holds a file you need, ask; do not take it. If a claim has
been held with no progress for hours, `--force` is available and must be
announced in the same breath.
