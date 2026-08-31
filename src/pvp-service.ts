import { assertService } from "./errors.ts";
import { assertProtocolVersion, fingerprint, type Clock } from "./runtime.ts";
import type { BackendStore } from "./store.ts";
import type {
  BattleCommand,
  CommandEnvelope,
  PvpEventEnvelope,
  RedactedMatchSnapshot,
  SessionPrincipal,
} from "./types.ts";

export class PvpService {
  private readonly store: BackendStore;
  private readonly clock: Clock;

  constructor(store: BackendStore, clock: Clock) {
    this.store = store;
    this.clock = clock;
  }

  async createSession(
    principal: SessionPrincipal,
    request: {
      protocolVersion: string;
      requestId: string;
      idempotencyKey: string;
      format: "standard" | "wild";
      deckId: string;
    },
  ): Promise<RedactedMatchSnapshot> {
    assertProtocolVersion(request.protocolVersion);
    assertService(request.requestId.trim().length > 0, 400, "REQUEST_ID_REQUIRED", "request ID is required");
    assertService(request.idempotencyKey.trim().length >= 8, 400, "IDEMPOTENCY_KEY_REQUIRED", "idempotency key is required");
    assertService(request.format === "standard" || request.format === "wild", 400, "INVALID_FORMAT", "PVP format is invalid");
    assertService(request.deckId.trim().length > 0, 400, "DECK_ID_REQUIRED", "deck ID is required");
    return this.store.createPvpSession({
      playerId: principal.playerId,
      requestId: request.requestId,
      idempotencyKey: request.idempotencyKey,
      protocolVersion: request.protocolVersion,
      format: request.format,
      deckId: request.deckId,
      fingerprint: await fingerprint(request),
      now: this.clock.now().toISOString(),
    });
  }

  async command(
    principal: SessionPrincipal,
    matchId: string,
    envelope: CommandEnvelope<BattleCommand>,
  ): Promise<RedactedMatchSnapshot> {
    assertProtocolVersion(envelope.protocolVersion);
    assertService(envelope.requestId.trim().length > 0, 400, "REQUEST_ID_REQUIRED", "request ID is required");
    assertService(envelope.idempotencyKey.trim().length >= 8, 400, "IDEMPOTENCY_KEY_REQUIRED", "idempotency key is required");
    assertService(Number.isSafeInteger(envelope.expectedVersion) && envelope.expectedVersion >= 0, 400, "INVALID_EXPECTED_VERSION", "expected version is invalid");
    return this.store.appendPvpCommand(
      principal.playerId,
      matchId,
      envelope,
      await fingerprint(envelope),
      this.clock.now().toISOString(),
    );
  }

  events(principal: SessionPrincipal, matchId: string, afterCursor: number, limit = 100): Promise<PvpEventEnvelope> {
    assertService(Number.isSafeInteger(afterCursor) && afterCursor >= 0, 400, "INVALID_CURSOR", "cursor must be a non-negative integer");
    return this.store.listPvpEvents(principal.playerId, matchId, afterCursor, Math.min(Math.max(limit, 1), 500));
  }
}

export interface PvpPollingBoundary {
  poll(principal: SessionPrincipal, matchId: string, afterCursor: number): Promise<PvpEventEnvelope>;
}

export class PollingPvpTransport implements PvpPollingBoundary {
  private readonly service: PvpService;

  constructor(service: PvpService) {
    this.service = service;
  }

  poll(principal: SessionPrincipal, matchId: string, afterCursor: number): Promise<PvpEventEnvelope> {
    return this.service.events(principal, matchId, afterCursor);
  }
}

export interface WebSocketPeer {
  send(payload: string): void;
}

/** WebSocket is only a delivery adapter; it emits the exact polling envelopes. */
export class WebSocketPvpTransport {
  private readonly service: PvpService;

  constructor(service: PvpService) {
    this.service = service;
  }

  async flush(peer: WebSocketPeer, principal: SessionPrincipal, matchId: string, afterCursor: number): Promise<number> {
    const envelope = await this.service.events(principal, matchId, afterCursor);
    peer.send(JSON.stringify(envelope));
    return envelope.cursor;
  }
}
