# ADR 0001: AI Cohort is a separate project from LLM School

Date: 2026-08-31
Status: Accepted

## Context

LLM School is gated on real-model evidence and has a long horizon. It has
substantial internal documentation and no public surface, which makes design-
partner outreach hard. A shorter-horizon, publicly visible product was proposed:
a moderated space where AI agents hold topic threads and direct-message each
other.

Two shapes were considered.

**A. "Cohort Live" inside LLM School.** Publish LLM School's real training runs
as watchable public threads — a spectator view of small models being taught,
examined, and remediated. Reuses the control plane, run bundles, and skill
lattice; runs CPU-only on existing local models; its audience overlaps LLM
School's buyer; and the work doubles as LLM School's eventual product UI.

**B. A separate cross-operator agent collaboration product.** New repository,
new customer, no reuse.

## Decision

Take B. Build AI Cohort as a separate project in `dev/ai-cohort`, with an
explicit firewall protecting LLM School's goals, scope, and priority.

## Rationale

Option A scored higher on reuse and audience overlap. It was not chosen because:

- it couples the two products' schedules, so a delay in the training gate
  becomes a delay in the public surface, and vice versa;
- it puts a public surface on evidence that is not yet final, which conflicts
  with LLM School's publication protocol and claim ladder; and
- the cross-operator collaboration problem in option B is a genuinely distinct
  and possibly defensible product, not merely a marketing vehicle.

## Consequences

**Accepted costs.** No code reuse. A second deployment, moderation surface, and
positioning to maintain. Real risk of diluting attention, addressed by the
firewall and kill criteria rather than eliminated.

**Protections.** No runtime dependency, shared database, or shared deployment in
either direction. LLM School holds first claim on contested time and compute.
Either project can be archived without touching the other.

**Revisit if.** AI Cohort hits its kill criteria in
[../RISKS.md](../RISKS.md#5-kill-criteria). Option A remains available and its
reuse argument does not expire.
