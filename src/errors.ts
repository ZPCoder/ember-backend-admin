export class ServiceError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ServiceError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function assertService(
  condition: unknown,
  status: number,
  code: string,
  message: string,
): asserts condition {
  if (!condition) throw new ServiceError(status, code, message);
}

const PUBLIC_ERROR_CODES = new Set([
  "INVALID_REQUEST",
  "AUTH_TICKET_INVALID",
  "AUTH_TICKET_REPLAYED",
  "SESSION_EXPIRED",
  "SESSION_REVOKED",
  "PROTOCOL_MAJOR_UNSUPPORTED",
  "CLIENT_VERSION_UNSUPPORTED",
  "CONFIG_VERSION_UNAVAILABLE",
  "PLAYER_NOT_FOUND",
  "VERSION_CONFLICT",
  "IDEMPOTENCY_CONFLICT",
  "MATCH_NOT_FOUND",
  "MATCH_ALREADY_FINISHED",
  "NOT_YOUR_TURN",
  "COMMAND_REJECTED",
  "CURSOR_EXPIRED",
  "RATE_LIMITED",
  "FORBIDDEN",
  "MIGRATION_INVALID",
  "MIGRATION_ALREADY_APPLIED",
  "INTERNAL_ERROR",
  "SERVICE_UNAVAILABLE",
]);

/** Collapse internal diagnostics to the frozen @zpcoder/ember-protocol error surface. */
export function publicErrorCode(error: ServiceError): string {
  if (PUBLIC_ERROR_CODES.has(error.code)) return error.code;
  if (error.code === "CHANNEL_TICKET_REPLAY") return "AUTH_TICKET_REPLAYED";
  if (error.code.includes("CHANNEL_TICKET") || error.code === "CHANNEL_VERIFICATION_FAILED") return "AUTH_TICKET_INVALID";
  if (error.code.includes("IDEMPOTENCY") || error.code === "SAVE_ALREADY_PREVIEWED") return "IDEMPOTENCY_CONFLICT";
  if (error.code.includes("MIGRATION")) return error.status === 409 ? "MIGRATION_ALREADY_APPLIED" : "MIGRATION_INVALID";
  if (error.code.includes("STALE") || error.code.includes("VERSION_CONFLICT")) return "VERSION_CONFLICT";
  if (error.code.includes("PVP_SESSION")) return "MATCH_NOT_FOUND";
  if (error.status === 401) return "SESSION_EXPIRED";
  if (error.status === 403) return "FORBIDDEN";
  if (error.status === 422) return "COMMAND_REJECTED";
  if (error.status === 429) return "RATE_LIMITED";
  if (error.status >= 500) return error.status === 503 ? "SERVICE_UNAVAILABLE" : "INTERNAL_ERROR";
  return "INVALID_REQUEST";
}
