# ADR 0007: Measure G7 in aggregate, without identifying readers

Status: Proposed
Date: 2026-09-02

## Context

G7 ranks spectating as a first-class product surface and measures it as "median
spectator session includes at least one thread opened and scrolled to its
artifact". Nothing collects that. The instrumentation page has reported the
measure as "not instrumented" since R1 shipped, and it is the last measure on
that page with no verdict available to it.

The measure as written cannot be taken inside this project's own scope.
[MVP_SPEC.md](../MVP_SPEC.md#4-scope-out) defers "any analytics beyond basic
traffic counts", and a median *session* containing a *scroll* to a particular
element needs three things that are each beyond a traffic count: a per-reader
identifier stable across requests, an ordered page sequence attached to it, and
client-side scroll instrumentation.

So a ranked goal carries a measure the project has decided not to implement.
[PRODUCT_GOALS.md](../PRODUCT_GOALS.md) says a goal without a measure is a mood.
A goal whose measure is never taken is worse than a mood: it cannot fail, and it
looks rigorous while not being so.

### The option declined

Promoting session analytics into scope was considered and rejected on four
independent grounds, any one of which would be enough.

C6 keeps reading account-free on purpose. Attaching a durable identifier to
somebody who deliberately has no account works against the reason that rule
exists, whatever the identifier is called and however lawful it is.

Scroll depth requires client-side JavaScript. This project is server-rendered
with no build step and no frontend framework, so this introduces a category of
code, and a category of bug, that does not currently exist.

[PRIVACY_RETENTION.md](../PRIVACY_RETENTION.md) currently stores nothing about
readers at all. Promoting this means writing a reader-data section, a retention
window, and a deletion path covering people who never agreed to anything and
cannot be contacted to be told.

N1 refuses engagement leaderboards as a product surface. Instrumenting
engagement is the first step toward optimizing for it, and that decay is the
thing this project was set up to avoid.

## Decision

*This ADR is Proposed. Nothing below is in force. G7's measure in
[PRODUCT_GOALS.md](../PRODUCT_GOALS.md) is unchanged and the instrumentation
page reports it as unmeasured, because a proposed decision cannot authorise its
own enactment — and this one alters a ranked goal, which is the owner's call
rather than an implementer's. On acceptance, this becomes Accepted and the
changes below are made as one commit.*

Amend G7's measure rather than build what the current one needs.

> **Measure:** at least a third of spectator page requests reach a thread rather
> than stopping at an index, counted in aggregate per page class, with no reader
> identity recorded and no client-side instrumentation.

Page classes are the index pages (`/`, `/topics`, `/artifacts`, and a topic's
own page) and the thread pages that carry contributions and artifacts. The
counter increments per request. Nothing distinguishes one reader from another,
nothing is stored per reader, and no request is retained.

Implementing that counter is a separate roadmap item, R16. This ADR authorises
it and says what it may collect; it does not build it. R16 must add to
[PRIVACY_RETENTION.md](../PRIVACY_RETENTION.md) a statement that aggregate
per-page-class counts are kept, that no reader identifier, IP address, or
request path beyond the class is retained, and that there is therefore no
reader-level deletion path because there is no reader-level record.

Until R16 lands, the instrumentation page states that G7's measure changed and
which item will make it computable, rather than implying the original
measurement is on its way.

## Consequences

- G7 becomes falsifiable. The new measure can report a failing number, which is
  the property the old one lacked and the reason for changing it.
- The measure is a proxy, and the ADR says so rather than pretending otherwise.
  It cannot distinguish one reader opening three threads from three readers
  opening one each. That ambiguity is the price of not identifying anyone, and
  it is being paid deliberately.
- The one-third bar is provisional. It is a starting line chosen without data,
  and the first real traffic should be used to set a defensible one. Revising it
  needs a superseding ADR: the bar is part of a goal's measure, and
  [CONTRIBUTING.md](../../CONTRIBUTING.md) requires an ADR to alter a goal. An
  earlier draft of this ADR claimed a roadmap edit would do, which contradicted
  that rule and would have let the bar be lowered to whatever the traffic
  happened to be.
- G7 is now measured more weakly than it was written. Anyone citing G7 as
  evidence that spectating works is citing navigation depth, not comprehension
  or interest, and should say which.
- The original measure remains the better one and stays unavailable. If the
  project ever accepts reader-level analytics, it needs a new ADR that answers
  the four objections above rather than a roadmap edit that quietly reinstates
  the old wording.
