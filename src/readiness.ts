export const CANONICAL_SCHEMA_VERSION = "1";

export interface SchemaStatus {
  ready: boolean;
  expectedVersion: string;
  actualVersion?: string;
  reason?: string;
}

export interface SchemaReadiness {
  status(): Promise<SchemaStatus>;
}

export class StaticSchemaReadiness implements SchemaReadiness {
  private readonly ready: boolean;

  constructor(ready = true) {
    this.ready = ready;
  }

  async status(): Promise<SchemaStatus> {
    return this.ready
      ? { ready: true, expectedVersion: CANONICAL_SCHEMA_VERSION, actualVersion: CANONICAL_SCHEMA_VERSION }
      : { ready: false, expectedVersion: CANONICAL_SCHEMA_VERSION, reason: "schema is not migrated" };
  }
}

interface D1StatementLike {
  bind(...values: unknown[]): D1StatementLike;
  first<T>(): Promise<T | null>;
}

export interface D1DatabaseLike {
  prepare(sql: string): D1StatementLike;
}

/** Read-only probe. Runtime code must never create, alter, or repair schema. */
export class D1SchemaReadiness implements SchemaReadiness {
  private readonly db: D1DatabaseLike;

  constructor(db: D1DatabaseLike) {
    this.db = db;
  }

  async status(): Promise<SchemaStatus> {
    try {
      const row = await this.db
        .prepare("SELECT value FROM schema_metadata WHERE key = ? LIMIT 1")
        .bind("canonical_schema_version")
        .first<{ value: string }>();
      const actualVersion = row?.value;
      return actualVersion === CANONICAL_SCHEMA_VERSION
        ? { ready: true, expectedVersion: CANONICAL_SCHEMA_VERSION, actualVersion }
        : {
            ready: false,
            expectedVersion: CANONICAL_SCHEMA_VERSION,
            ...(actualVersion === undefined ? {} : { actualVersion }),
            reason: "canonical migration has not been applied",
          };
    } catch {
      return {
        ready: false,
        expectedVersion: CANONICAL_SCHEMA_VERSION,
        reason: "schema metadata is unavailable",
      };
    }
  }
}
