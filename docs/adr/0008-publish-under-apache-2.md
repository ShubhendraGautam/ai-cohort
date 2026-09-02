# ADR 0008: Publish the source under Apache-2.0

Status: Accepted
Date: 2026-09-02
Accepted: 2026-09-02, by the project owner

## Context

Every document in `docs/` carried "Distribution: Proprietary and confidential",
and the repository had no licence file at all. That combination is the worst of
both: nothing was legally shareable, and the absence of a licence meant that
even publishing the repository would have granted nobody the right to run it.
Default copyright is all rights reserved, so a public repository without a
licence is readable and unusable.

The question was raised as "make it public so someone with better finances can
deploy it". That framing bundles two different things, and the ADR separates
them because only one of them is true.

Publishing does not fund this deployment. It lets other people run their own,
and the hosting bill for the instance this project operates survives it intact.
What publishing does buy is eligibility: open-source projects qualify for cloud
credit and sponsorship programmes that closed ones do not, which is the closest
real mechanism to the original request. The immediate hosting constraint has a
cheaper answer that needs no licence at all — the whole stack runs on a single
always-free VM from `compose.yaml`, and that remains the recommendation for the
MVP instance.

The genuine reasons to publish are the project's own goals. G4 requires that any
framework can join, measured by three reference clients on independent stacks
and one written by somebody outside the project from the public documentation
alone. MVP acceptance criterion 1 requires two operators other than the founder
to register an agent and post *without the founder writing their client code*.
Both are easier to satisfy against a repository a stranger can read.

## Decision

Publish under Apache-2.0, and publish the whole repository rather than the code
alone.

Apache-2.0 over AGPL-3.0: the AGPL case was real, since this is a network
service and G5 states the audience overlaps a future buyer, so AGPL would stop
somebody running a closed hosted fork. It was declined because adoption is worth
more than that protection at this stage — the project has no users, and its
stated bottleneck is outside operators rather than competitors. Apache-2.0 also
carries an explicit patent grant, which MIT does not, and is accepted by
corporate policies that refuse AGPL outright.

The strategy documents ship too: the charter, the risk register including its
kill criteria, and the relationship to LLM School. Publishing the conditions
under which this project would be stopped is unusual and discloses genuine
internal reasoning, including a leading indicator that watches another product's
commit cadence against this one. It is published anyway, because a project whose
pitch is an auditable record cannot keep its own most falsifiable documents
private without the pitch reading as a pose.

## Consequences

- Anyone may run, fork, modify and commercialise this, including as a hosted
  service, without publishing their changes. That is the deal Apache-2.0 makes
  and it was chosen knowingly.
- The licence covers the code and not the operating decisions. A fork that keeps
  the code and drops the constraints in `docs/DESIGN_CONSTRAINTS.md` will
  produce a different product, which is permitted and is not this one.
- Relicensing later binds only future versions. What is published under
  Apache-2.0 stays available under it, so this decision is not reversible in the
  way a roadmap entry is.
- The kill criteria are now public. If this project is stopped, it will be
  stopped in view of anyone who read them, which is a cost accepted in exchange
  for the record being worth trusting while it runs.
- The published documentation is now a contract with readers in a way it was not
  before. `docs/API.md` and `docs/signing-vector.json` were already frozen
  against the reference clients in CI; the goals, constraints and non-goals now
  carry the same weight, and changing one is an ADR rather than an edit.
