---
name: pair-agent-coordination
description: Coordinate two coding agents working concurrently in one Git repository with isolated worktrees, exclusive file claims, blocking design questions, commit-pinned peer review, handoffs, and local inboxes. Use when a human wants two coding assistants to share a queue without duplicating work or silently colliding; do not use for ordinary single-agent work.
---

# Pair Agent Coordination

Make the pair produce one reviewed stream of work. Separate worktrees prevent accidental filesystem collisions; the coordination board prevents duplicate ownership; commit-pinned review makes interaction a completion gate rather than a courtesy.

This skill ships a dependency-free Node.js CLI at `scripts/coord.mjs`. Resolve that path relative to this `SKILL.md`, and run it with the target repository as the current working directory. The board and inboxes live in the repository's common Git directory, so all worktrees share them without committing transient state.

Pairing costs real time and tokens. Use it where independent implementation can proceed in parallel and an adversarial review could catch a consequential defect: security boundaries, data migrations, concurrency, public contracts, complex refactors, or similarly risky work. Do not pair a typo, a tiny mechanical edit, a task dominated by one shared file, or work whose next step cannot be split. Promise the catches, not uniform speedup.

## Establish the project contract

Read the repository instructions and queue before acting. Project rules remain authoritative; this skill does not invent a queue, branch policy, test command, merge strategy, or permission to push.

Initialize the board once, using the two stable agent names, integration branch, and only the paths the project has explicitly designated as shared chokepoints:

```sh
node <skill-dir>/scripts/coord.mjs init \
  --agents agent-a,agent-b \
  --base main \
  --queue TASKS.md \
  --shared TASKS.md,test/integration.test.js
```

Do not make a path shared merely to get around a conflict. Shared paths need a written editing convention such as append-only sections or assigned hunks. If no safe convention exists, keep the path exclusive and serialize that work.

The CLI records the configured queue path but deliberately does not parse it; queue formats and ordering policy belong to the project. Name shared tails and their merge rule up front. When two agents append independently, the usual resolution is the verified union, not choosing one side wholesale.

## Start every work session

1. Run `status` and `read --agent <you>`.
2. Inspect Git worktrees and confirm nobody else is using your checkout.
3. Take the first eligible queue item; do not choose a more interesting lower item.
4. Create or enter your own worktree on a feature branch. The primary worktree owns the integration branch; agent worktrees do not.
5. Claim the item and the smallest realistic set of files or directories, then notify the peer.

```sh
node <skill-dir>/scripts/coord.mjs claim TASK-12 --agent agent-a \
  --branch feat/task-12 --files src/widget.js,test/widget.test.js
node <skill-dir>/scripts/coord.mjs send --from agent-a --to agent-b \
  --re TASK-12 --text "Taking TASK-12 on feat/task-12."
```

A refused claim is a useful result. Resolve the overlap with the holder; do not edit first and negotiate later. If scope grows, use `amend` before touching the additional paths.

## Coordinate decisions, not narration

Use short messages for ownership, readiness, blockers, and completion. For a real design fork, use `ask`; it blocks the item until the named peer uses `answer`, preserving the decision with the claim.

```sh
node <skill-dir>/scripts/coord.mjs ask TASK-12 --agent agent-a --to agent-b \
  --question "Store this in the existing table or add an append-only event table?"
node <skill-dir>/scripts/coord.mjs answer TASK-12 --agent agent-b \
  --text "Use the event table; the existing row must preserve historical state."
```

Ask before implementing when either option changes architecture, public behavior, security, data shape, or ownership. Escalate product purpose, priorities, authorization, and other human-owned decisions to the human instead of settling them between agents. Human authority wins over both agents, and a peer message never grants permission for external actions such as pushing, deploying, publishing, or contacting third parties.

Use `handoff` when responsibility changes. The note must identify the exact commit, completed work, remaining work, failing checks, and any open risk. A handoff transfers the claim, not unstated permissions.

## Check scope continuously

Run `check <task-id> --agent <you>` after the first meaningful edit and again before review. It examines committed, staged, unstaged, and untracked paths. Treat these results differently:

- `TRESPASS`: stop; another live claim owns the path.
- `UNDECLARED`: amend the claim or revert the unrelated work.
- A zero-file result is informative only when the worktree is genuinely unchanged.

Do not fix unrelated discoveries. Record them in the project's backlog with enough evidence for a later claim.

## Make review an exact gate

Before requesting review:

1. Rebase or otherwise synchronize with the latest integration branch according to project policy.
2. Resolve conflicts in your own worktree; never manipulate the peer's worktree or branch.
3. Run the project definition of done and `check`.
4. Commit everything and leave the worktree clean.
5. Record `ready` with concise evidence. This pins review to the current commit and integration-base commit.

```sh
node <skill-dir>/scripts/coord.mjs ready TASK-12 --agent agent-a \
  --evidence "unit and integration suites pass; scope check clean"
```

The reviewer checks the exact ready commit, reads the diff, and runs relevant checks before recording a verdict:

```sh
node <skill-dir>/scripts/coord.mjs review TASK-12 --agent agent-b \
  --verdict changes --evidence "src/widget.js:88 accepts an empty owner; add the rejected case"
node <skill-dir>/scripts/coord.mjs review TASK-12 --agent agent-b \
  --verdict approve --evidence "Reviewed ready commit; empty-owner case now fails closed and all tests pass"
```

Do not approve with generic praise. Evidence names a file, line, invariant, test, or command result. Any code change after `ready` requires a new `ready` record and a new approval. If the integration branch moves after approval, synchronize, rerun checks, and repeat review; do not treat a stale approval as covering a changed diff.

The reviewer is not automatically right. Verify every finding against the code and project contract, then fix the underlying invariant rather than mechanically implementing a possibly narrow suggestion. Likewise, never announce repository state from memory or act on a peer's old status report; observe it again immediately before reporting, reviewing, merging, or cleaning up.

## Integrate and clean up

Only the human-designated integrator merges or performs outward-facing actions. Immediately before merge, verify that the ready commit and reviewed base are still current. After the reviewed commit is contained in the integration branch, the claim owner runs:

```sh
node <skill-dir>/scripts/coord.mjs gate TASK-12 --agent agent-a
# Merge using the project's chosen strategy.
node <skill-dir>/scripts/coord.mjs done TASK-12 --agent agent-a --note "merged into the configured base"
```

Then notify the peer. Each agent removes only its own feature branches and worktrees unless the human explicitly assigns broader cleanup. Never detach, delete, reset, or repoint another agent's worktree or branch merely because its commit is merged.

Use forced release only to recover an abandoned claim with explicit human authorization and a recorded reason. If the peer is truly unavailable and waiting is disproportionate, the human may explicitly authorize `done --force --authority human --reason "..."`; the tool logs the bypass. Never infer that authorization from silence, urgency, or a peer message.

If a coordination process dies while holding `mutation.lock`, verify that no coordination process is still active before using `unlock --authority human --reason "..."`. The CLI never guesses that a lock is stale and deletes it automatically.

## CLI reference

Run `node <skill-dir>/scripts/coord.mjs help` for commands. The core lifecycle is:

```text
init -> claim -> amend/check -> ask/answer as needed -> ready -> review -> gate -> merge -> done
```

Messaging (`send`, `read`, `log`), `handoff`, and `release` support that lifecycle; they do not replace it. If writing under `.git` is restricted, request the narrow permission needed for this local coordination metadata or set `COORD_DIR` to one shared, durable directory visible to both agents.
