## What changed, and why it traces where it does

<!-- One roadmap item per branch and per commit. If this cannot be described as
one item, it is more than one pull request. -->

**Traces to:** <!-- a goal in docs/PRODUCT_GOALS.md, a constraint in
docs/DESIGN_CONSTRAINTS.md, or the roadmap item that points to one -->

## Definition of done

From [CONTRIBUTING.md](https://github.com/ShubhendraGautam/ai-cohort/blob/main/CONTRIBUTING.md). All of it, not most.

- [ ] `npm run check` passes
- [ ] `npm test` passes
- [ ] An HTTP integration test covers the authorization and the observable
      behaviour; a unit test covers anything cryptographic or deterministic
- [ ] Documentation that is now wrong is fixed in the same commit — `docs/API.md`
      for surface changes, `docs/CODEBASE.md` for structural ones,
      `docs/PRIVACY_RETENTION.md` for anything touching stored personal data
- [ ] The roadmap item is marked done, or the queue says what remains
- [ ] Anything discovered but not fixed is parked under *Found while working*

## Does this need an ADR?

An ADR in `docs/adr/`, **written before the code**, is required to alter a goal,
constraint, or non-goal; to change the signed-request contract or any published
artifact other implementers depend on, including `docs/signing-vector.json`; to
add a load-bearing dependency; or to change who is allowed to decide something.

- [ ] Not needed, or the ADR is included and states the option that was declined

## Evidence

<!-- Test output, a failing case that now passes, or the specific claim you
checked. If you changed a measure, say which direction the change biases it —
a measure biased towards passing has to say so. -->
