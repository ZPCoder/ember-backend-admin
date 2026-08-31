import type { AdminService } from "./admin-service.ts";
import type { AuthService } from "./auth-service.ts";
import { createId } from "./crypto.ts";
import { ServiceError, assertService, publicErrorCode } from "./errors.ts";
import type { PlayerService } from "./player-service.ts";
import type { PvpService } from "./pvp-service.ts";
import type { SchemaReadiness } from "./readiness.ts";
import type {
  AdminPrincipal,
  BattleCommand,
  ChannelLoginRequest,
  CommandEnvelope,
  JsonValue,
  PlayerCommand,
} from "./types.ts";

export interface ApiRequest {
  method: string;
  url: string;
  headers?: Record<string, string | undefined>;
  body?: unknown;
  remoteAddress?: string;
}

export interface ApiResponse {
  status: number;
  headers: Record<string, string>;
  body?: JsonValue;
}

export interface AdminAuthenticator {
  authenticate(request: ApiRequest): Promise<AdminPrincipal>;
}

export interface ApiRouterOptions {
  allowedOrigins: string[];
  frameAncestors: string[];
}

interface RouterServices {
  readiness: SchemaReadiness;
  auth: AuthService;
  players: PlayerService;
  pvp: PvpService;
  admin: AdminService;
  adminAuthenticator: AdminAuthenticator;
}

function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

export class ApiRouter {
  private readonly services: RouterServices;
  private readonly options: ApiRouterOptions;

  constructor(services: RouterServices, options: ApiRouterOptions) {
    this.services = services;
    this.options = options;
  }

  async handle(request: ApiRequest): Promise<ApiResponse> {
    const origin = this.header(request, "origin");
    const requestId = this.header(request, "x-request-id") ?? createId("request");
    try {
      if (origin !== undefined) {
        assertService(this.options.allowedOrigins.includes(origin), 403, "ORIGIN_NOT_ALLOWED", "request origin is not allowed");
      }
      if (request.method.toUpperCase() === "OPTIONS") return this.response(204, undefined, origin);
      const url = new URL(request.url, "https://backend.invalid");
      if (url.pathname === "/healthz") {
        const status = await this.services.readiness.status();
        return this.response(status.ready ? 200 : 503, status, origin);
      }
      const schema = await this.services.readiness.status();
      if (!schema.ready) {
        return this.response(
          503,
          {
            code: "SERVICE_UNAVAILABLE",
            message: "canonical database migration is required",
            requestId,
            retryable: true,
          },
          origin,
        );
      }

      const method = request.method.toUpperCase();
      if (method === "POST" && url.pathname === "/v1/auth/channel/exchange") {
        const body = this.objectBody<ChannelLoginRequest>(request);
        const userAgent = this.header(request, "user-agent");
        const response = await this.services.auth.exchange(body, {
          ...(request.remoteAddress === undefined ? {} : { ipAddress: request.remoteAddress }),
          ...(userAgent === undefined ? {} : { userAgent }),
        });
        return this.response(200, response, origin);
      }

      if (method === "GET" && url.pathname === "/v1/player") {
        const principal = await this.playerPrincipal(request);
        return this.response(200, await this.services.players.get(principal), origin);
      }
      if (method === "POST" && url.pathname === "/v1/player/commands") {
        const principal = await this.playerPrincipal(request);
        const envelope = this.objectBody<CommandEnvelope<PlayerCommand>>(request);
        this.requireIdempotencyHeader(request, envelope.idempotencyKey);
        return this.response(200, await this.services.players.command(principal, envelope), origin);
      }
      if (method === "POST" && url.pathname === "/v1/pvp/sessions") {
        const principal = await this.playerPrincipal(request);
        const body = this.objectBody<{ protocolVersion: string; format: "standard" | "wild"; deckId: string }>(request);
        return this.response(201, await this.services.pvp.createSession(principal, {
          ...body,
          requestId,
          idempotencyKey: this.requireIdempotencyHeader(request),
        }), origin);
      }
      if (method === "POST" && url.pathname === "/v1/pvp/commands") {
        const principal = await this.playerPrincipal(request);
        const matchId = url.searchParams.get("matchId") ?? "";
        assertService(matchId.length > 0, 400, "PVP_MATCH_REQUIRED", "matchId is required");
        const envelope = this.objectBody<CommandEnvelope<BattleCommand>>(request);
        this.requireIdempotencyHeader(request, envelope.idempotencyKey);
        return this.response(202, await this.services.pvp.command(principal, matchId, envelope), origin);
      }
      if (method === "GET" && url.pathname === "/v1/pvp/events") {
        const principal = await this.playerPrincipal(request);
        const matchId = url.searchParams.get("matchId") ?? "";
        assertService(matchId.length > 0, 400, "PVP_MATCH_REQUIRED", "matchId is required");
        const afterCursor = Number(url.searchParams.get("after") ?? "0");
        const limit = Number(url.searchParams.get("limit") ?? "100");
        return this.response(200, await this.services.pvp.events(principal, matchId, afterCursor, limit), origin);
      }

      if (url.pathname.startsWith("/v1/admin/")) {
        const admin = await this.services.adminAuthenticator.authenticate(request);
        if (method === "GET" && url.pathname === "/v1/admin/players") {
          return this.response(200, await this.services.admin.searchPlayers(admin, url.searchParams.get("query") ?? ""), origin);
        }
        if (method === "POST" && url.pathname === "/v1/admin/migrations/preview") {
          const body = this.objectBody<Parameters<AdminService["previewLegacyMigration"]>[1]>(request);
          return this.response(200, await this.services.admin.previewLegacyMigration(admin, body), origin);
        }
        if (method === "POST" && url.pathname === "/v1/admin/migrations/apply") {
          const body = this.objectBody<{
            migrationId: string;
            requestId: string;
            confirmation: { confirmed: true; confirmationText: string };
          }>(request);
          return this.response(
            200,
            await this.services.admin.applyLegacyMigration(admin, body.migrationId, body.requestId, body.confirmation),
            origin,
          );
        }
        if (method === "POST" && url.pathname === "/v1/admin/migrations/rollback") {
          const body = this.objectBody<{
            migrationId: string;
            requestId: string;
            confirmation: { confirmed: true; confirmationText: string };
          }>(request);
          return this.response(
            200,
            await this.services.admin.rollbackLegacyMigration(admin, body.migrationId, body.requestId, body.confirmation),
            origin,
          );
        }
        if (method === "GET" && url.pathname === "/v1/admin/audit") {
          return this.response(200, await this.services.admin.listAudit(admin, Number(url.searchParams.get("limit") ?? "100")), origin);
        }
        if (method === "GET" && url.pathname === "/v1/admin/pvp/replay") {
          return this.response(200, await this.services.admin.replay(admin, url.searchParams.get("matchId") ?? ""), origin);
        }
        if (method === "GET" && url.pathname === "/v1/admin/config-version") {
          return this.response(200, await this.services.admin.configState(admin), origin);
        }
      }
      throw new ServiceError(404, "ROUTE_NOT_FOUND", "API route does not exist");
    } catch (error) {
      if (error instanceof ServiceError) {
        return this.response(
          error.status,
          {
            code: publicErrorCode(error),
            message: error.message,
            requestId,
            retryable: error.status === 429 || error.status >= 500,
          },
          origin,
        );
      }
      return this.response(500, {
        code: "INTERNAL_ERROR",
        message: "unexpected backend error",
        requestId,
        retryable: true,
      }, origin);
    }
  }

  private async playerPrincipal(request: ApiRequest) {
    const authorization = this.header(request, "authorization") ?? "";
    assertService(authorization.startsWith("Bearer "), 401, "BEARER_TOKEN_REQUIRED", "bearer access token is required");
    return this.services.auth.authenticate(authorization.slice("Bearer ".length));
  }

  private objectBody<T>(request: ApiRequest): T {
    assertService(request.body !== null && typeof request.body === "object" && !Array.isArray(request.body), 400, "JSON_BODY_REQUIRED", "JSON object body is required");
    return request.body as T;
  }

  private requireIdempotencyHeader(request: ApiRequest, envelopeKey?: string): string {
    const value = this.header(request, "idempotency-key") ?? "";
    assertService(value.length >= 8 && value.length <= 128, 400, "IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key header is required");
    assertService(envelopeKey === undefined || value === envelopeKey, 409, "IDEMPOTENCY_KEY_REUSED", "header and envelope idempotency keys differ");
    return value;
  }

  private header(request: ApiRequest, name: string): string | undefined {
    const entry = Object.entries(request.headers ?? {}).find(([key]) => key.toLocaleLowerCase() === name);
    return entry?.[1];
  }

  private response(status: number, body: unknown, origin?: string): ApiResponse {
    const headers: Record<string, string> = {
      "cache-control": "no-store",
      "content-security-policy": `default-src 'none'; frame-ancestors ${this.options.frameAncestors.join(" ")}`,
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    };
    if (origin !== undefined && this.options.allowedOrigins.includes(origin)) {
      headers["access-control-allow-origin"] = origin;
      headers["access-control-allow-credentials"] = "true";
      headers["access-control-allow-headers"] = "authorization, content-type, idempotency-key, x-request-id";
      headers["access-control-allow-methods"] = "GET, POST, OPTIONS";
      headers.vary = "Origin";
    }
    return {
      status,
      headers,
      ...(body === undefined ? {} : { body: jsonValue(body) }),
    };
  }
}
