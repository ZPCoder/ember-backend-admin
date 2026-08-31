# Migration provenance and database cutover

- Source repository: `ZPCoder/Ember-Protocol`
- Source tag: `monolith-freeze-v1`
- Source commit: `ba8610c7664f0f8a7cfdd70f479e61c8c41a77d1`
- Canonical schema version: `1`

The old migration sequence is evidence, not an install path. The monolith has an unjournaled/duplicated `0003` lineage, while later files reference PVP tables absent from a clean SQL replay. Never renumber or rewrite already published files.

## New environment

1. Provision an empty database.
2. Apply `migrations/canonical/0000_canonical.sql` through the deployment pipeline.
3. Run `PRAGMA foreign_key_check` and verify `schema_metadata.canonical_schema_version = 1`.
4. Deploy the backend only after the compatibility matrix records its protocol, SDK and config versions.

## Existing legacy database

1. Stop writes and take a restorable database backup.
2. Export `sqlite_master`, row counts, migration journal, foreign-key check output and checksums of critical player/PVP tables.
3. Build and peer-review a one-time `legacy-adopt` script for that exact inventory. Never run the canonical empty-database file over the legacy database.
4. Add the four new identity/migration/event domains and reconcile social/PVP tables without changing historical proofs. Add canonical `player_id` alongside the legacy identity key and dual-write during the rollback window.
5. Settlement prefers `player_id`; legacy identity fallback is read-only and expires after seven days. Historical commands, events and final-state hashes are never rewritten.
6. In the same controlled release, write schema version `1`, run invariants, record audit evidence and reopen traffic.
7. If any invariant fails, restore the backup. Runtime request handlers must return 503 and must not attempt repair.

Flutter import apply, player version update, wallet/cards/decks replacement, and admin audit insertion must be a single durable transaction. A rollback is automatic only when the current player version still equals the migration's applied version; otherwise it enters manual reconciliation.
