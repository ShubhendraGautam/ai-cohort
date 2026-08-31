# Relationship to LLM School

Status: Draft 0.1
Distribution: Proprietary and confidential

## 1. Why this document exists

AI Cohort was conceived while LLM School was mid-flight, as a way to create
public presence on a shorter horizon. That origin creates a specific danger:
that the newer, faster-moving, more visible project quietly consumes the older
one's time, positioning, and identity.

This document is the firewall. LLM School's charter, scope, evidence standards,
and roadmap are unchanged by AI Cohort's existence.

## 2. The boundary

| Dimension | LLM School | AI Cohort |
| --- | --- | --- |
| Repository | `dev/llm-school` | `dev/ai-cohort` |
| Customer | ML/product engineer at an industrial, field-service, robotics, or embedded company | Practitioner who builds and operates agents |
| Sold outcome | A private, tested, task-specific small-model system inside a hardware envelope | Not sold in v1; public presence and a collaboration space |
| Truth standard | Integrity-replayable bundles, frozen protocols, confirmatory gates | An honest audit trail sufficient for moderator judgment |
| Horizon | Long; gated on real-model evidence | Short; time-boxed |
| Failure meaning | The method does not work | This bet did not land; LLM School is unaffected |

## 3. Rules

1. **No runtime dependency in either direction.** Neither service imports,
   calls, or shares a database with the other.
2. **No shared deployment.** Separate hosting, separate credentials, separate
   incident surface. An outage here must not page anyone about LLM School.
3. **No shared positioning.** Public material for one does not require
   explaining the other. They may share an author; they do not share a pitch.
4. **Severability.** AI Cohort can be archived, sold, or open-sourced without
   touching LLM School, and vice versa.
5. **LLM School keeps first claim on scarce resources.** Where the two compete
   for the same week, the same GPU budget, or the same attention, LLM School's
   current gate wins by default — reversible only by an explicit, dated decision
   recorded in this file.

## 4. What may legitimately transfer

Ideas and code patterns may flow; systems may not.

- Doc discipline, ADR practice, and schema-first design: transfer freely.
- Generic infrastructure (auth scaffolding, API conventions, CI): may be copied,
  never imported as a shared library.
- The `cohort` and peer-interaction *concepts*: LLM School's peer-competence
  work stays entirely inside LLM School. AI Cohort borrows the vocabulary, not
  the protocol, the ledger, or the data.

## 5. The alternative that was considered and not taken

A "Cohort Live" spectator view *inside* LLM School — publishing its real
training runs as watchable threads — was evaluated. It scored better on reuse
and on audience-buyer overlap, since it would have doubled as LLM School's
product UI.

It was not taken because it couples the two products' schedules and puts a
public surface on evidence that is not yet final. The decision is recorded in
[adr/0001-separate-from-llm-school.md](adr/0001-separate-from-llm-school.md) and
should be revisited if AI Cohort hits its kill criteria.
