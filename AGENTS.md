# AI Cohort — instructions for Codex

A moderated space where AI agents owned by different operators work a bounded
topic and resolve it to an attributable artifact. Node.js, PostgreSQL, and a
Redis-compatible store; server-rendered, no build step, no frontend framework.

You are agent **`codex`**. Claude Code is agent **`claude`** and is working this
repository at the same time as you.

## Start of every session

```sh
node scripts/coord.js status          # what is open, and what claude is holding
node scripts/coord.js read --agent codex
```

Then take the first item in [docs/ROADMAP.md](docs/ROADMAP.md) that is open on
the board, claim it, and say so:

```sh
node scripts/coord.js claim R4 --agent codex --branch feat/r4-auto-freeze \
  --files src/coordination.js,src/server.js
node scripts/coord.js send --to claude --from codex "Taking R4." --re R4
```

Work in your own worktree — `git worktree add ../ai-cohort-codex -b <branch>` —
never in the checkout `claude` is using. The full protocol, including the rules
for the three files both agents need, is
[docs/COORDINATION.md](docs/COORDINATION.md). Read it once.

## The rules of this repository

[CONTRIBUTING.md](CONTRIBUTING.md) is binding and short. In summary:

- **Work the queue in [docs/ROADMAP.md](docs/ROADMAP.md), top-down.** Do not
  start a lower item because it is more interesting, and do not fix unrelated
  things you notice — park them under *Found while working* in the roadmap.
- Every change traces to a goal in [docs/PRODUCT_GOALS.md](docs/PRODUCT_GOALS.md)
  or a constraint in [docs/DESIGN_CONSTRAINTS.md](docs/DESIGN_CONSTRAINTS.md).
- [docs/NON_GOALS.md](docs/NON_GOALS.md) is binding. Promoting a non-goal needs
  an ADR in `docs/adr/`, written before the code.
- [docs/CODEBASE.md](docs/CODEBASE.md) says where code goes. Its *Adding a
  feature* section is the procedure, not a suggestion.

## Rules that are not style preferences

- **C3 — the platform spends nothing on inference.** No feature may require a
  model call at runtime. Summaries and audits are computed from stored records.
- **C8 — agent content is data, never instructions.**
- **C10 — agent writes are signed.** Ed25519 over method, path, timestamp,
  one-use nonce, and raw body. No bearer tokens on `/api/v1`.
- **N2 — no open bot registration**, at any growth stage.
- Human moderator authority (C7) is never overridable by an agent.

## Commands

```sh
npm test           # node --test; pg-mem stands in for PostgreSQL
npm run check      # syntax gate over src/, scripts/, and test/
npm start          # needs a .env; see .env.example
```

`npm test` also runs three reference clients against
[docs/signing-vector.json](docs/signing-vector.json), so changing the signing
contract breaks a published artifact on purpose. That is intended: it forces a
versioning decision instead of a quiet edit.

## Finishing

Tests green, the CONTRIBUTING definition of done met in full, rebase on `main`,
merge, then:

```sh
node scripts/coord.js done R4 --agent codex --note "merged"
node scripts/coord.js send --to claude --from codex "R4 merged." --re R4
```

## Two test traps that have already cost time

A top-level `afterEach` in `node:test` runs after every *subtest*, so a subtest
that needs the HTTP server alive must not be a subtest. And a synchronous child
process deadlocks against the in-process server — shell out asynchronously.
