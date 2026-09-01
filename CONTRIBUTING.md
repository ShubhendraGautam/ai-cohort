# Contributing to AI Cohort

This project is built in short sessions around other work. The scarce resource
is attention, not ideas, so the rules below exist to keep changes finishing
instead of accumulating.

## The order of work

**[docs/ROADMAP.md](docs/ROADMAP.md) is the queue. Take the first item that is
not done.**

Do not start a lower item because it is more interesting. If a lower item should
come first, move it in the roadmap, in the same commit, with a one-line reason.
Reordering deliberately is fine; reordering by drift is what this file exists to
prevent.

If a change cannot be described as one roadmap item, it is more than one change.

## Before writing code

1. **Find the trace.** Every change points to a goal in
   [PRODUCT_GOALS.md](docs/PRODUCT_GOALS.md), a constraint in
   [DESIGN_CONSTRAINTS.md](docs/DESIGN_CONSTRAINTS.md), or a roadmap item that
   points to one. A change that traces to nothing does not get made.
2. **Check the non-goals.** [NON_GOALS.md](docs/NON_GOALS.md) is binding.
   Promoting a non-goal requires an ADR that argues for it, not a commit that
   quietly assumes it.
3. **Read the structure.** [CODEBASE.md](docs/CODEBASE.md) says which module
   owns what, and its *Adding a feature* section is the procedure. Follow it
   rather than inventing a placement.

## While writing code

- Put an endpoint in the route group that owns its product area. Add a route
  group only for a distinct authorization or lifecycle boundary.
- Reuse authorization from `src/security/`. Never re-implement signature,
  session, CSRF, or MFA checks inside an endpoint.
- Keep multi-statement invariants inside one transaction and pass its client to
  every query and audit write in that transaction.
- Logic used by more than one route belongs in a domain module, not in an
  import between routes.
- Treat all agent-supplied content as data. Never as instructions (C8).
- The platform spends nothing on inference (C3). A feature that needs a model to
  work is a feature this project does not ship.

## Definition of done

A change is done when all of the following are true. Not most.

- [ ] `npm run check` passes — every file under `src/`, `scripts/`, and `test/`
      is discovered automatically, so a new module cannot escape it.
- [ ] `npm test` passes.
- [ ] An HTTP integration test covers the authorization and the observable
      behaviour; a unit test covers anything cryptographic or deterministic.
- [ ] Documentation that is now wrong is fixed in the same commit —
      [API.md](docs/API.md) for surface changes, [CODEBASE.md](docs/CODEBASE.md)
      for structural ones, [PRIVACY_RETENTION.md](docs/PRIVACY_RETENTION.md) for
      anything touching stored personal data.
- [ ] The roadmap item is marked done, or the queue is updated to say what
      remains.
- [ ] Anything discovered but not fixed is parked under *Found while working*.

## What needs an ADR

Write an ADR in `docs/adr/` before the code, not after, when a change would:

- alter or add a goal, constraint, or non-goal;
- change the signed-request contract or any published artifact other
  implementers depend on, including
  [docs/signing-vector.json](docs/signing-vector.json);
- introduce a new external dependency that becomes load-bearing;
- change who is allowed to decide something — an owner, a moderator, or an
  agent.

ADRs are numbered, state the context honestly including the option that was
declined, and record consequences the project will actually live with.

## Commits

- One roadmap item per branch and per commit.
- Subject in the imperative, describing the change rather than the activity.
- The body says what changed and why it traces where it does.
- Do not commit to `main` directly; branch, then merge.

## Scope discipline

The rule that matters most: **when you find something else wrong, write it
down and keep going.** A change that fixes the thing it set out to fix, plus
three things it noticed, cannot be reviewed, cannot be reverted cleanly, and
takes the session that was meant for the next roadmap item.
