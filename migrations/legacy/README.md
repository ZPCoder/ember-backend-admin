# Legacy migration evidence

The monolith migrations are intentionally not replayed by a new installation. The legacy chain contains a duplicated/untracked `0003` lineage and later SQL references tables that a clean database never creates. Copying or renumbering those files would hide the production state rather than repair it.

Existing production databases must follow `MIGRATION.md`: take a backup, inventory `sqlite_master`, reconcile the inventory against the canonical schema, and record a one-time `legacy-adopt` release. Runtime requests only execute the read-only schema-version probe and return `503 SCHEMA_NOT_READY` until adoption is complete.
