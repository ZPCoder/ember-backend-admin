import { sha256 } from "./crypto.ts";
import { assertService } from "./errors.ts";
import type { JsonValue } from "./types.ts";

export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

function normalize(value: unknown): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    assertService(Number.isFinite(value), 400, "NON_FINITE_NUMBER", "JSON values must be finite");
    return value;
  }
  if (Array.isArray(value)) return value.map(normalize);
  assertService(typeof value === "object", 400, "INVALID_JSON_VALUE", "value is not valid JSON");
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, normalize(item)]),
  );
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

export function fingerprint(value: unknown): Promise<string> {
  return sha256(canonicalJson(value));
}

// Keep this value in lockstep with @zpcoder/ember-protocol. Protocol 1.0 has
// no earlier minor; when 1.1 is published the supported set becomes 1.1/1.0.
export const CURRENT_PROTOCOL_VERSION = "1.0";
export const SUPPORTED_PROTOCOL_VERSIONS = new Set([CURRENT_PROTOCOL_VERSION]);

export function assertProtocolVersion(version: string): void {
  if (SUPPORTED_PROTOCOL_VERSIONS.has(version)) return;
  const major = /^(0|[1-9][0-9]*)\./.exec(version)?.[1];
  const currentMajor = CURRENT_PROTOCOL_VERSION.split(".")[0];
  assertService(
    false,
    426,
    major !== currentMajor ? "PROTOCOL_MAJOR_UNSUPPORTED" : "CLIENT_VERSION_UNSUPPORTED",
    `protocol ${version} is unsupported; update the client`,
  );
}
