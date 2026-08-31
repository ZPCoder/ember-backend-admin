# Ember backend + admin

Authoritative player assets, channel identity, formal PVP persistence, social data, Flutter save review, analytics ingestion schema, and the operator console live here. The package is intentionally framework-neutral: services accept narrow ports, the router adapts them to `/v1`, and Cloudflare D1 or Node/PostgreSQL/Redis adapters can implement `BackendStore` without changing protocol semantics.

## Implemented vertical slice

- `Platform4399Adapter` accepts only an opaque one-time ticket and delegates official server-to-server verification. It declares `supportsPayment=false`; there is no product or recharge API.
- Opaque access tokens expire after 15 minutes by default. Only SHA-256 token and ticket hashes cross the storage boundary, and a consumed ticket cannot be replayed.
- Player commands and PVP commands enforce `idempotencyKey` plus `expectedVersion`. The memory adapter demonstrates the atomic contract used by durable adapters.
- Polling and WebSocket delivery use the same `PvpEventEnvelope`; WebSocket is not a second game protocol.
- Public PVP uses canonical `matchId`, cursor/state versions and
  `RedactedMatchSnapshot`; opponent hand contents never enter the envelope.
- Flutter saves are size/card/range/slot validated, previewed as a diff, applied once, audited, and rolled back automatically only while the applied player version remains current.
- Administrator reads require granular RBAC. Every write requires both a role and an exact typed confirmation.
- The canonical empty-database migration creates player assets, 27 deck slots, social/PVP state, channel accounts, sessions, audit, migration and event tables with constraints and indexes.
- Runtime readiness performs one `SELECT` against `schema_metadata`. It never executes `CREATE`, `ALTER`, or opportunistic repair; an unready deployment returns HTTP 503.

## API surface

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/auth/channel/exchange` | Verify a one-time platform ticket and issue a short session |
| GET | `/v1/player` | Read the server-authoritative player projection |
| POST | `/v1/player/commands` | Apply an idempotent, versioned player command |
| POST | `/v1/pvp/sessions` | Enter a formal PVP session |
| POST | `/v1/pvp/commands` | Submit an authoritative battle command |
| GET | `/v1/pvp/events` | Poll events after a cursor |
| GET | `/v1/admin/players` | Search players |
| POST | `/v1/admin/migrations/{preview,apply,rollback}` | Audited legacy-save workflow |
| GET | `/v1/admin/{audit,pvp/replay,config-version}` | Audit, replay and release diagnostics |

`AdminAuthenticator` must be backed by the organisation identity proxy. Never construct administrator roles from browser headers. The static console under `admin/` relies on a same-origin authenticated gateway.

## Local verification

```sh
npm install
npm run check
sqlite3 ':memory:' '.bail on' '.read migrations/canonical/0000_canonical.sql' \
  'PRAGMA foreign_key_check;' \
  "SELECT CASE count(*) WHEN 1 THEN 1 ELSE json_extract('invalid', '$') END FROM schema_metadata WHERE key='canonical_schema_version' AND value='1';"
```

The test suite covers ticket replay, session expiry, optimistic concurrency, idempotency-key misuse, equivalent PVP transports, migration validation/apply/rollback, RBAC confirmation, CORS, schema readiness, absence of runtime DDL, and canonical schema coverage.

## Production gates

The 4399 gateway remains an injected interface until current official documents and a sandbox account are supplied. Business must confirm the no-recharge H5 submission path in writing; payment work is deliberately out of scope. The in-memory store is for deterministic tests only. A production release must provide a transactional D1 or PostgreSQL implementation and pass the migration, replay and 500-CCU gates managed by `ember-ops`.
