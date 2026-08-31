import { createId } from "./crypto.ts";
import { ServiceError, assertService } from "./errors.ts";
import type {
  AdminAuditEntry,
  BattleCommand,
  CommandEnvelope,
  ConfigState,
  JsonValue,
  LegacyFlutterSaveV1,
  LegacyMigrationPreview,
  PlayerCommand,
  PlayerView,
  PvpEvent,
  PvpEventEnvelope,
  RedactedMatchSnapshot,
  SessionPrincipal,
} from "./types.ts";

export interface CreateAuthenticatedSessionInput {
  platform: string;
  subject: string;
  displayName?: string;
  ticketHash: string;
  tokenHash: string;
  expiresAt: string;
  now: string;
}

export interface AuthenticatedSessionResult {
  player: PlayerView;
  principal: SessionPrincipal;
}

export interface CreatePvpSessionInput {
  playerId: string;
  requestId: string;
  idempotencyKey: string;
  protocolVersion: string;
  format: "standard" | "wild";
  deckId: string;
  fingerprint: string;
  now: string;
}

export interface LegacyApplyInput {
  preview: LegacyMigrationPreview;
  save: LegacyFlutterSaveV1;
  adminId: string;
  requestId: string;
  now: string;
}

export interface BackendStore {
  createAuthenticatedSession(input: CreateAuthenticatedSessionInput): Promise<AuthenticatedSessionResult>;
  resolveSession(tokenHash: string, now: string): Promise<SessionPrincipal | null>;
  getPlayer(playerId: string): Promise<PlayerView | null>;
  searchPlayers(query: string, limit: number): Promise<PlayerView[]>;
  applyPlayerCommand(
    playerId: string,
    envelope: CommandEnvelope<PlayerCommand>,
    fingerprint: string,
  ): Promise<PlayerView>;
  createPvpSession(input: CreatePvpSessionInput): Promise<RedactedMatchSnapshot>;
  appendPvpCommand(
    playerId: string,
    matchId: string,
    envelope: CommandEnvelope<BattleCommand>,
    fingerprint: string,
    now: string,
  ): Promise<RedactedMatchSnapshot>;
  listPvpEvents(playerId: string, matchId: string, afterCursor: number, limit: number): Promise<PvpEventEnvelope>;
  getPvpReplay(matchId: string): Promise<PvpEventEnvelope[]>;
  saveMigrationPreview(preview: LegacyMigrationPreview, save: LegacyFlutterSaveV1, now: string): Promise<void>;
  getMigrationPreview(migrationId: string): Promise<{ preview: LegacyMigrationPreview; save: LegacyFlutterSaveV1 } | null>;
  applyLegacyMigration(input: LegacyApplyInput): Promise<PlayerView>;
  rollbackLegacyMigration(migrationId: string, adminId: string, requestId: string, now: string): Promise<PlayerView>;
  appendAudit(entry: AdminAuditEntry): Promise<void>;
  listAudit(limit: number): Promise<AdminAuditEntry[]>;
  getConfigState(): Promise<ConfigState>;
}

interface StoredIdempotency<T> {
  fingerprint: string;
  value: T;
}

interface StoredSession extends SessionPrincipal {
  tokenHash: string;
  revokedAt?: string;
}

interface StoredPvpSession {
  id: string;
  playerIds: string[];
  protocolVersion: string;
  format: "standard" | "wild";
  deckId: string;
  stateVersion: number;
  cursor: number;
  deadlineAt: string;
  events: Array<{ cursor: number; stateVersion: number; event: PvpEvent }>;
}

interface StoredMigration {
  preview: LegacyMigrationPreview;
  save: LegacyFlutterSaveV1;
  status: "previewed" | "applied" | "rolled_back";
  before?: PlayerView;
  after?: PlayerView;
  appliedVersion?: number;
  createdAt: string;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function defaultPlayer(playerId: string, commanderName?: string): PlayerView {
  return {
    id: playerId,
    commanderName: commanderName?.trim() || "新指挥官",
    version: 1,
    gold: 0,
    dust: 0,
    packs: {},
    collection: {},
    decks: [],
    format: "standard",
    stats: { wins: 0, losses: 0, draws: 0 },
  };
}

export class MemoryBackendStore implements BackendStore {
  private readonly players = new Map<string, PlayerView>();
  private readonly platformAccounts = new Map<string, string>();
  private readonly consumedTickets = new Set<string>();
  private readonly sessions = new Map<string, StoredSession>();
  private readonly playerIdempotency = new Map<string, StoredIdempotency<PlayerView>>();
  private readonly pvpIdempotency = new Map<string, StoredIdempotency<RedactedMatchSnapshot>>();
  private readonly pvpCreateIdempotency = new Map<string, StoredIdempotency<RedactedMatchSnapshot>>();
  private readonly pvpSessions = new Map<string, StoredPvpSession>();
  private readonly migrations = new Map<string, StoredMigration>();
  private readonly migrationSourceByPlayer = new Map<string, string>();
  private readonly audits: AdminAuditEntry[] = [];
  private config: ConfigState = {
    version: "1.0.0",
    sha256: "0".repeat(64),
    activatedAt: new Date(0).toISOString(),
  };

  seedPlayer(player: PlayerView): void {
    this.players.set(player.id, clone(player));
  }

  setConfigState(config: ConfigState): void {
    this.config = clone(config);
  }

  async createAuthenticatedSession(input: CreateAuthenticatedSessionInput): Promise<AuthenticatedSessionResult> {
    assertService(!this.consumedTickets.has(input.ticketHash), 409, "CHANNEL_TICKET_REPLAY", "channel ticket was already used");
    const accountKey = `${input.platform}:${input.subject}`;
    let playerId = this.platformAccounts.get(accountKey);
    if (!playerId) {
      playerId = createId("player");
      this.platformAccounts.set(accountKey, playerId);
      this.players.set(playerId, defaultPlayer(playerId, input.displayName));
    }
    this.consumedTickets.add(input.ticketHash);
    const sessionId = createId("session");
    const principal: SessionPrincipal = {
      sessionId,
      playerId,
      provider: input.platform,
      expiresAt: input.expiresAt,
    };
    this.sessions.set(input.tokenHash, { ...principal, tokenHash: input.tokenHash });
    const player = this.players.get(playerId);
    if (!player) throw new ServiceError(500, "PLAYER_MISSING", "platform account has no player");
    return { player: clone(player), principal };
  }

  async resolveSession(tokenHash: string, now: string): Promise<SessionPrincipal | null> {
    const stored = this.sessions.get(tokenHash);
    if (!stored || stored.revokedAt || Date.parse(stored.expiresAt) <= Date.parse(now)) return null;
    return {
      sessionId: stored.sessionId,
      playerId: stored.playerId,
      provider: stored.provider,
      expiresAt: stored.expiresAt,
    };
  }

  async getPlayer(playerId: string): Promise<PlayerView | null> {
    const player = this.players.get(playerId);
    return player ? clone(player) : null;
  }

  async searchPlayers(query: string, limit: number): Promise<PlayerView[]> {
    const normalized = query.trim().toLocaleLowerCase();
    return [...this.players.values()]
      .filter((player) => player.id.toLocaleLowerCase().includes(normalized) || player.commanderName.toLocaleLowerCase().includes(normalized))
      .slice(0, limit)
      .map(clone);
  }

  async applyPlayerCommand(
    playerId: string,
    envelope: CommandEnvelope<PlayerCommand>,
    fingerprint: string,
  ): Promise<PlayerView> {
    const idempotencyScope = `player:${playerId}:${envelope.idempotencyKey}`;
    const previous = this.playerIdempotency.get(idempotencyScope);
    if (previous) {
      assertService(previous.fingerprint === fingerprint, 409, "IDEMPOTENCY_KEY_REUSED", "idempotency key has different content");
      return clone(previous.value);
    }
    const player = this.players.get(playerId);
    assertService(player, 404, "PLAYER_NOT_FOUND", "player does not exist");
    assertService(player.version === envelope.expectedVersion, 409, "STALE_PLAYER_VERSION", "expected player version does not match");
    const next = clone(player);
    switch (envelope.command.type) {
      case "set-commander-name":
        next.commanderName = envelope.command.commanderName.trim();
        break;
      case "save-deck": {
        const replacement = clone(envelope.command.deck);
        const requestedCounts = new Map<string, number>();
        for (const cardId of replacement.cardIds) requestedCounts.set(cardId, (requestedCounts.get(cardId) ?? 0) + 1);
        for (const [cardId, requested] of requestedCounts) {
          assertService(
            requested <= (player.collection[cardId] ?? 0),
            422,
            "CARD_NOT_OWNED",
            `deck requests more copies than the player owns: ${cardId}`,
          );
        }
        next.decks = [...next.decks.filter((deck) => deck.slot !== replacement.slot), replacement].sort((a, b) => a.slot - b.slot);
        break;
      }
      case "delete-deck": {
        const slot = envelope.command.slot;
        next.decks = next.decks.filter((deck) => deck.slot !== slot);
        break;
      }
    }
    next.version += 1;
    this.players.set(playerId, next);
    this.playerIdempotency.set(idempotencyScope, { fingerprint, value: clone(next) });
    return clone(next);
  }

  async createPvpSession(input: CreatePvpSessionInput): Promise<RedactedMatchSnapshot> {
    const key = `pvp-create:${input.playerId}:${input.idempotencyKey}`;
    const previous = this.pvpCreateIdempotency.get(key);
    if (previous) {
      assertService(previous.fingerprint === input.fingerprint, 409, "IDEMPOTENCY_KEY_REUSED", "idempotency key has different content");
      return clone(previous.value);
    }
    assertService(this.players.has(input.playerId), 404, "PLAYER_NOT_FOUND", "player does not exist");
    const matchId = createId("match");
    const session: StoredPvpSession = {
      id: matchId,
      playerIds: [input.playerId],
      protocolVersion: input.protocolVersion,
      format: input.format,
      deckId: input.deckId,
      stateVersion: 0,
      cursor: 0,
      deadlineAt: new Date(Date.parse(input.now) + 75_000).toISOString(),
      events: [],
    };
    this.pvpSessions.set(matchId, session);
    const snapshot = this.snapshot(session, input.playerId);
    this.pvpCreateIdempotency.set(key, { fingerprint: input.fingerprint, value: clone(snapshot) });
    return snapshot;
  }

  async appendPvpCommand(
    playerId: string,
    matchId: string,
    envelope: CommandEnvelope<BattleCommand>,
    fingerprint: string,
    now: string,
  ): Promise<RedactedMatchSnapshot> {
    const scope = `pvp:${matchId}:${playerId}:${envelope.idempotencyKey}`;
    const previous = this.pvpIdempotency.get(scope);
    if (previous) {
      assertService(previous.fingerprint === fingerprint, 409, "IDEMPOTENCY_KEY_REUSED", "idempotency key has different content");
      return clone(previous.value);
    }
    const session = this.pvpSessions.get(matchId);
    assertService(session, 404, "PVP_SESSION_NOT_FOUND", "PVP match does not exist");
    assertService(session.playerIds.includes(playerId), 403, "NOT_A_PARTICIPANT", "player is not a participant");
    assertService(session.stateVersion === envelope.expectedVersion, 409, "STALE_MATCH_VERSION", "expected match version does not match");
    session.stateVersion += 1;
    session.cursor += 1;
    const event: PvpEvent = {
      type: "command-accepted",
      occurredAt: now,
      payload: {
        actorPlayerId: playerId,
        commandType: envelope.command.type,
      },
    };
    session.events.push({ cursor: session.cursor, stateVersion: session.stateVersion, event });
    const snapshot = this.snapshot(session, playerId);
    this.pvpIdempotency.set(scope, { fingerprint, value: clone(snapshot) });
    return snapshot;
  }

  async listPvpEvents(playerId: string, matchId: string, afterCursor: number, limit: number): Promise<PvpEventEnvelope> {
    const session = this.pvpSessions.get(matchId);
    assertService(session, 404, "PVP_SESSION_NOT_FOUND", "PVP match does not exist");
    assertService(session.playerIds.includes(playerId), 403, "NOT_A_PARTICIPANT", "player is not a participant");
    const events = session.events
      .filter((record) => record.cursor > afterCursor)
      .slice(0, limit)
      .map((record) => clone(record.event));
    return {
      protocolVersion: session.protocolVersion,
      matchId: session.id,
      cursor: session.cursor,
      stateVersion: session.stateVersion,
      events,
      snapshot: this.snapshot(session, playerId),
    };
  }

  async getPvpReplay(matchId: string): Promise<PvpEventEnvelope[]> {
    const session = this.pvpSessions.get(matchId);
    assertService(session, 404, "PVP_SESSION_NOT_FOUND", "PVP match does not exist");
    const viewer = session.playerIds[0];
    assertService(viewer, 500, "MATCH_PARTICIPANT_MISSING", "PVP match has no participant");
    return [
      {
        protocolVersion: session.protocolVersion,
        matchId: session.id,
        cursor: session.cursor,
        stateVersion: session.stateVersion,
        events: session.events.map((record) => clone(record.event)),
        snapshot: this.snapshot(session, viewer),
      },
    ];
  }

  async saveMigrationPreview(preview: LegacyMigrationPreview, save: LegacyFlutterSaveV1, now: string): Promise<void> {
    const existing = this.migrations.get(preview.migrationId);
    if (existing) {
      assertService(existing.preview.sourceHash === preview.sourceHash, 409, "MIGRATION_ID_REUSED", "migration ID has different content");
      return;
    }
    const sourceKey = `${preview.playerId}:${preview.sourceHash}`;
    const otherMigrationId = this.migrationSourceByPlayer.get(sourceKey);
    assertService(!otherMigrationId, 409, "SAVE_ALREADY_PREVIEWED", "the same legacy save was already submitted");
    this.migrationSourceByPlayer.set(sourceKey, preview.migrationId);
    this.migrations.set(preview.migrationId, {
      preview: clone(preview),
      save: clone(save),
      status: "previewed",
      createdAt: now,
    });
  }

  async getMigrationPreview(migrationId: string): Promise<{ preview: LegacyMigrationPreview; save: LegacyFlutterSaveV1 } | null> {
    const migration = this.migrations.get(migrationId);
    return migration ? { preview: clone(migration.preview), save: clone(migration.save) } : null;
  }

  async applyLegacyMigration(input: LegacyApplyInput): Promise<PlayerView> {
    const migration = this.migrations.get(input.preview.migrationId);
    assertService(migration, 404, "MIGRATION_NOT_FOUND", "migration preview does not exist");
    if (migration.status === "applied") {
      assertService(migration.after, 500, "MIGRATION_RESULT_MISSING", "applied migration has no result snapshot");
      return clone(migration.after);
    }
    assertService(migration.status === "previewed", 409, "MIGRATION_NOT_APPLICABLE", "migration cannot be applied in its current state");
    assertService(migration.preview.valid, 422, "INVALID_LEGACY_SAVE", "invalid legacy save cannot be applied");
    const player = this.players.get(input.preview.playerId);
    assertService(player, 404, "PLAYER_NOT_FOUND", "player does not exist");
    assertService(player.version === input.preview.currentPlayerVersion, 409, "STALE_MIGRATION_PREVIEW", "player changed after preview");
    const before = clone(player);
    const next: PlayerView = {
      id: player.id,
      commanderName: input.save.commanderName,
      version: player.version + 1,
      gold: input.save.gold,
      dust: input.save.dust,
      packs: clone(input.save.packs),
      collection: clone(input.save.collection),
      decks: input.save.decks.map((deck) => ({
        ...clone(deck),
        deckCode: deck.deckCode ?? "",
      })),
      format: input.save.format,
      stats: clone(input.save.record),
    };
    this.players.set(player.id, next);
    migration.before = before;
    migration.after = clone(next);
    migration.appliedVersion = next.version;
    migration.status = "applied";
    await this.appendAudit({
      id: createId("audit"),
      adminId: input.adminId,
      action: "legacy-save.apply",
      targetType: "player",
      targetId: player.id,
      requestId: input.requestId,
      before: asJson(before),
      after: asJson(next),
      createdAt: input.now,
    });
    return clone(next);
  }

  async rollbackLegacyMigration(migrationId: string, adminId: string, requestId: string, now: string): Promise<PlayerView> {
    const migration = this.migrations.get(migrationId);
    assertService(migration, 404, "MIGRATION_NOT_FOUND", "migration does not exist");
    assertService(migration.status === "applied" && migration.before && migration.appliedVersion !== undefined, 409, "MIGRATION_NOT_ROLLBACKABLE", "migration is not applied");
    const current = this.players.get(migration.preview.playerId);
    assertService(current, 404, "PLAYER_NOT_FOUND", "player does not exist");
    assertService(current.version === migration.appliedVersion, 409, "ROLLBACK_VERSION_CONFLICT", "player changed after migration; manual reconciliation is required");
    const restored = clone(migration.before);
    restored.version = current.version + 1;
    this.players.set(restored.id, restored);
    migration.status = "rolled_back";
    await this.appendAudit({
      id: createId("audit"),
      adminId,
      action: "legacy-save.rollback",
      targetType: "player",
      targetId: restored.id,
      requestId,
      before: asJson(current),
      after: asJson(restored),
      createdAt: now,
    });
    return clone(restored);
  }

  async appendAudit(entry: AdminAuditEntry): Promise<void> {
    this.audits.push(clone(entry));
  }

  async listAudit(limit: number): Promise<AdminAuditEntry[]> {
    return this.audits.slice(-limit).reverse().map(clone);
  }

  async getConfigState(): Promise<ConfigState> {
    return clone(this.config);
  }

  private snapshot(session: StoredPvpSession, playerId: string): RedactedMatchSnapshot {
    const opponentId = session.playerIds.find((candidate) => candidate !== playerId) ?? "pending-opponent";
    const publicState = (id: string) => ({
      playerId: id,
      heroHealth: 30,
      heroArmor: 0,
      mana: 0,
      maxMana: 0,
      deckCount: 0,
      handCount: 0,
      board: [],
    });
    return {
      matchId: session.id,
      stateVersion: session.stateVersion,
      cursor: session.cursor,
      phase: session.stateVersion === 0 ? "mulligan" : "playing",
      turn: session.stateVersion,
      activePlayerId: session.playerIds[session.stateVersion % session.playerIds.length] ?? playerId,
      viewer: { ...publicState(playerId), hand: [] },
      opponent: publicState(opponentId),
      winnerId: null,
      deadlineAt: session.deadlineAt,
    };
  }
}
