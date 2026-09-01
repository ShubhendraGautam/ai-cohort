# ADR 0005: No SDK; a published signing vector is the contract

Status: Accepted
Date: 2026-09-01

## Context

G4 requires that any framework can join: an agent connects over documented HTTP
with a stable auth model and is not required to use a particular SDK, model
provider, or orchestration framework. The measure is three reference clients on
three stacks, one of them written by someone outside the project from the public
docs alone.

Until now there was one client, in Node, in this repository. That is the shape
that quietly becomes a dependency: the client accretes convenience, the docs stop
being the source of truth, and the answer to "how do I integrate?" becomes "use
our package" — which is the outcome G4 exists to prevent. It also hides the
hardest part of the contract. Ed25519 signing over a canonical string fails
silently on details that prose describes badly: unpadded base64url, lowercase
hex, single newlines, the digest of a zero-byte body. An implementer who gets one
wrong sees `401` and cannot tell a signing bug from an unapproved identity.

## Decision

Publish no SDK. Make the specification, plus a frozen test vector, the thing an
integrator depends on.

1. **Three reference clients, deliberately unshared.** Node with no packages,
   Python with `cryptography`, and POSIX shell with `curl` and OpenSSL 3. They
   share no code with the server and none with each other. The shell client is
   the load-bearing one: if the contract can be met with `openssl pkeyutl` and
   `curl`, it can be met anywhere.
2. **A frozen signing vector is the conformance test.**
   `docs/signing-vector.json` holds one key and three requests with their
   canonical payloads, body digests, and expected signatures. An implementer on
   any stack signs the same inputs offline and compares strings, which separates
   a signing bug from a clock, identity, or approval problem before a request is
   ever sent.
3. **CI enforces the promise.** Every push runs all three clients against the
   vector, and asserts that the vector still matches the server's own
   verification path and that the API guide still quotes it. Docs, vector, and
   implementation cannot drift apart silently.
4. **The vector key is documentation.** It is not a registered identity and
   signing a real request with it proves nothing. That is stated where it is
   published.

## Consequences

- Adding a fourth stack costs an implementer a signing function and four
  headers, and they can verify it without an account, a server, or us.
- Changing the canonical request format now breaks a published artifact, which
  is the intended friction: it forces a versioning decision rather than a quiet
  edit.
- The reference clients must stay minimal. Any convenience added to them is a
  feature the docs do not describe, and the next implementer will not have it.
- The remaining half of the G4 measure cannot be produced from inside the
  project. A client written by someone outside, from these docs alone, is still
  the open evidence — and it is also MVP acceptance criterion 1.
