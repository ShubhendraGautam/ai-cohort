# Working two agents in parallel

Status: Draft 0.1
Distribution: Proprietary and confidential

Two agents — Claude Code and Codex — work this repository at the same time to
finish the queue faster. They are not users of the product and this is not a
demonstration of it; it is how the work gets done. Nothing here is a product
surface and nothing here traces to a goal, for the same reason
[CONTRIBUTING.md](../CONTRIBUTING.md) does not.

Parallelism fails in exactly two ways: both agents do the same task, or both
edit the same file. Claims and worktrees prevent those — but staying out of each
other's way is not collaboration, and two agents working in silence produce two
half-reviewed branches instead of one good one.

So interaction is a gate, not a courtesy:

- **An item cannot be marked done without an approving review from the other
  agent.** `done` refuses.
- **A review must carry evidence** — a file, a line, a case that fails, the
  specific claim checked. `review` refuses "looks good".
- **A design question blocks its own item** until the other agent answers it.
- **A handoff carries a note** saying where the work was left.

The failure mode to watch for is not conflict, it is agreement: two models
politely approving each other produces worse work than one model alone. A review
whose evidence does not name something specific is a rubber stamp, and the
second agent's whole value is being the one who did not write the code.

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

## Deciding something together

When an item reaches a real fork — a design choice, an unclear constraint,
anything that would otherwise be settled by whoever typed first — put it to the
other agent and let it block:

```sh
node scripts/coord.js ask R4 --agent codex \
  --question "In-process timer per instance, or a scheduled task? Two stateless instances."
node scripts/coord.js answer R4 --agent claude \
  --text "Scheduled task; two timers would race on the audit write."
```

The item shows as `waiting on <agent>` and cannot be finished while the question
is open. Both the question and the answer stay on the claim, so the reasoning
survives into the ADR the decision deserves.

## Reviewing each other

```sh
node scripts/coord.js review R4 --agent claude --verdict changes \
  --evidence "src/db.js:352 still prunes inside the request path; no test advances the clock"
node scripts/coord.js review R4 --agent claude --verdict approve \
  --evidence "request-path prune removed; test advances updated_at past the window"
```

Read the diff before reviewing it. Run the tests before approving. A `changes`
verdict is the useful one — it is the only reason there are two agents rather
than one working twice as long.

## Handing work over

```sh
node scripts/coord.js handoff R4 --agent codex --to claude \
  --note "schema and pruning done; the admin surface and its test are not"
```

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
| `src/db.js` | Schema changes are **append-only new table blocks**, or `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` at the end with a `schema_migrations` marker. Never restructure an existing block. |
| `test/app.test.js` | Append your test at the end. Rebase before you finish, not after. |
| `docs/API.md`, `docs/CODEBASE.md` | Add sections; do not reorganize. |
| `docs/ROADMAP.md` | Only the agent finishing an item edits it, and only to move that item, plus one line under *Found while working*. |

Before you finish an item, `node scripts/coord.js check --agent <name>` diffs
your branch against `main` and tells you whether every file you touched is one
you declared or one of the shared set. It exits non-zero on a file another live
claim declared. Claims were honoured by convention until this existed, and
convention lost twice in the first session: once when an agent edited a file it
had not declared, once when two agents edited the same page from different
items.

`coord.js claim` **refuses to lock these** and says so. Every item needs a
schema line and a test, so locking them to one claim serializes exactly the work
the second agent was added to parallelize. The cost is that both agents append
to the end of the same two files and must rebase early; that is a cheap merge
conflict, and the alternative is no parallelism at all.

## Finishing an item

1. `npm run check` and `npm test` pass on your branch.
2. The definition of done in [CONTRIBUTING.md](../CONTRIBUTING.md) is met — the
   whole checklist, including the docs and the roadmap entry.
3. Tell the other agent the branch is ready, and wait. It reads the diff, runs
   the tests, and records `approve` or `changes` with evidence.
4. Address a `changes` verdict on the same branch, then ask again.
5. Rebase on `main`, run the tests again, and merge.
6. `coord.js done <id>`, which refuses unless an approving review exists.

If the other agent holds a file you need, ask; do not take it. If a claim has
been held with no progress for hours, `--force` is available and must be
announced in the same breath.
