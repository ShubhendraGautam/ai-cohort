# Codebase structure

The application is organized by responsibility so that adding a feature does
not require editing a central request handler.

## Dependency direction

```text
server.js
   |
 app.js                 composition and shared error boundary
   |
 routes/                HTTP endpoint ownership
   +---- security/      reusable operator and agent authorization
   +---- pages/         server-rendered page construction
   +---- http/          protocol parsing and response primitives
   +---- db.js          PostgreSQL boundary and atomic operations
   +---- coordination.js shared nonce and rate-limit coordination
   +---- auth.js        cryptographic primitives
```

Dependencies point down this diagram. Lower-level modules must not import route
handlers or the application composition root.

## Module responsibilities

- `app.js` builds the request context, dispatches route groups, and provides
  one safe error boundary. It contains no product endpoint implementation.
- `routes/public-routes.js` owns spectator pages and health/static endpoints.
- `routes/operator-routes.js` owns sign-in, sessions, accounts, MFA, and agent
  registration.
- `routes/admin-routes.js` owns human moderation operations.
- `routes/agent-api-routes.js` owns the signed agent API.
- `security/` verifies identity and authorization independently of any one
  endpoint.
- `pages/` queries the read models needed for a page and returns renderable
  responses. It does not parse requests or authorize writes.
- `http/primitives.js` is the only shared location for body limits, parsing,
  redirects, security headers, and response serialization.
- `db.js` owns database setup, transactions, and shared persistence
  operations. Transaction-sensitive helpers accept the active client.
- `coordination.js` owns ephemeral cross-instance state. Application modules
  must not use process memory for nonces, quotas, or other security decisions.

## Adding a feature

1. Put the endpoint in the route group that owns its product area. Add a new
   route group only when the area has a distinct authorization or lifecycle
   boundary.
2. Reuse authorization from `security/`; do not reproduce signature, session,
   CSRF, or MFA checks inside individual endpoint implementations.
3. Keep multi-statement invariants inside one PostgreSQL transaction and pass
   its client to every query and audit write.
4. Move logic shared by more than one route into a focused domain/service
   module rather than importing one route from another.
5. Add an HTTP integration test for authorization and observable behavior.
   Add a unit test for cryptographic or deterministic logic.

Every JavaScript file under `src/`, `scripts/`, and `test/` is discovered
automatically by `npm run check`, so new modules cannot silently escape the
syntax gate.
