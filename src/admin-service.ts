import { createId, sha256 } from "./crypto.ts";
import { assertService } from "./errors.ts";
import type { CardCatalog } from "./player-service.ts";
import { canonicalJson, type Clock } from "./runtime.ts";
import type { BackendStore } from "./store.ts";
import type {
  AdminAuditEntry,
  AdminPrincipal,
  AssetDiff,
  ConfigState,
  JsonValue,
  LegacyFlutterSaveV1,
  LegacyMigrationPreview,
  PlayerView,
  PvpEventEnvelope,
} from "./types.ts";

export interface AdminConfirmation {
  confirmed: true;
  confirmationText: string;
}

const ALL_ADMIN_ROLES = new Set([
  "player.read",
  "migration.review",
  "migration.apply",
  "migration.rollback",
  "audit.read",
  "replay.read",
  "config.read",
]);

function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

export class AdminService {
  private readonly store: BackendStore;
  private readonly catalog: CardCatalog;
  private readonly clock: Clock;

  constructor(store: BackendStore, catalog: CardCatalog, clock: Clock) {
    this.store = store;
    this.catalog = catalog;
    this.clock = clock;
  }

  async searchPlayers(principal: AdminPrincipal, query: string): Promise<PlayerView[]> {
    this.requireRole(principal, "player.read");
    assertService(query.trim().length >= 2, 400, "SEARCH_QUERY_TOO_SHORT", "player query must contain at least two characters");
    return this.store.searchPlayers(query, 50);
  }

  async previewLegacyMigration(
    principal: AdminPrincipal,
    request: {
      migrationId: string;
      playerId: string;
      save: LegacyFlutterSaveV1;
      confirmation: AdminConfirmation;
      requestId: string;
    },
  ): Promise<LegacyMigrationPreview> {
    this.requireRole(principal, "migration.review");
    this.requireConfirmation(request.confirmation, `PREVIEW ${request.migrationId}`);
    assertService(/^migration_[A-Za-z0-9_-]{8,128}$/.test(request.migrationId), 400, "INVALID_MIGRATION_ID", "migration ID is invalid");
    const player = await this.store.getPlayer(request.playerId);
    assertService(player, 404, "PLAYER_NOT_FOUND", "player does not exist");
    const serialized = canonicalJson(request.save);
    assertService(new TextEncoder().encode(serialized).byteLength <= 2_000_000, 413, "LEGACY_SAVE_TOO_LARGE", "legacy save exceeds 2 MB");
    const sourceHash = await sha256(serialized);
    const existing = await this.store.getMigrationPreview(request.migrationId);
    if (existing) {
      assertService(
        existing.preview.playerId === request.playerId && existing.preview.sourceHash === sourceHash,
        409,
        "MIGRATION_ID_REUSED",
        "migration ID has different player or content",
      );
      return existing.preview;
    }
    const errors = this.validateSave(request.save);
    const preview: LegacyMigrationPreview = {
      migrationId: request.migrationId,
      playerId: player.id,
      sourceHash,
      currentPlayerVersion: player.version,
      valid: errors.length === 0,
      errors,
      diff: this.buildDiff(player, request.save),
    };
    await this.store.saveMigrationPreview(preview, request.save, this.clock.now().toISOString());
    await this.store.appendAudit({
      id: createId("audit"),
      adminId: principal.adminId,
      action: "legacy-save.preview",
      targetType: "player",
      targetId: player.id,
      requestId: request.requestId,
      after: asJson(preview),
      createdAt: this.clock.now().toISOString(),
    });
    return preview;
  }

  async applyLegacyMigration(
    principal: AdminPrincipal,
    migrationId: string,
    requestId: string,
    confirmation: AdminConfirmation,
  ): Promise<PlayerView> {
    this.requireRole(principal, "migration.apply");
    this.requireConfirmation(confirmation, `APPLY ${migrationId}`);
    const migration = await this.store.getMigrationPreview(migrationId);
    assertService(migration, 404, "MIGRATION_NOT_FOUND", "migration preview does not exist");
    return this.store.applyLegacyMigration({
      preview: migration.preview,
      save: migration.save,
      adminId: principal.adminId,
      requestId,
      now: this.clock.now().toISOString(),
    });
  }

  rollbackLegacyMigration(
    principal: AdminPrincipal,
    migrationId: string,
    requestId: string,
    confirmation: AdminConfirmation,
  ): Promise<PlayerView> {
    this.requireRole(principal, "migration.rollback");
    this.requireConfirmation(confirmation, `ROLLBACK ${migrationId}`);
    return this.store.rollbackLegacyMigration(
      migrationId,
      principal.adminId,
      requestId,
      this.clock.now().toISOString(),
    );
  }

  listAudit(principal: AdminPrincipal, limit = 100): Promise<AdminAuditEntry[]> {
    this.requireRole(principal, "audit.read");
    return this.store.listAudit(Math.min(Math.max(limit, 1), 500));
  }

  replay(principal: AdminPrincipal, matchId: string): Promise<PvpEventEnvelope[]> {
    this.requireRole(principal, "replay.read");
    return this.store.getPvpReplay(matchId);
  }

  configState(principal: AdminPrincipal): Promise<ConfigState> {
    this.requireRole(principal, "config.read");
    return this.store.getConfigState();
  }

  private requireRole(principal: AdminPrincipal, role: string): void {
    assertService(ALL_ADMIN_ROLES.has(role), 500, "UNKNOWN_ADMIN_ROLE", "server requested an unknown administrator role");
    assertService(
      principal.roles.includes("superadmin") || principal.roles.includes(role),
      403,
      "ADMIN_ROLE_REQUIRED",
      `administrator role is required: ${role}`,
    );
  }

  private requireConfirmation(confirmation: AdminConfirmation, phrase: string): void {
    assertService(
      confirmation?.confirmed === true && confirmation.confirmationText === phrase,
      409,
      "ADMIN_CONFIRMATION_REQUIRED",
      `type “${phrase}” to confirm`,
    );
  }

  private validateSave(save: LegacyFlutterSaveV1): string[] {
    const errors: string[] = [];
    if (save.schemaVersion !== 1) errors.push("schemaVersion must be 1");
    const nameLength = typeof save.commanderName === "string" ? save.commanderName.trim().length : 0;
    if (nameLength < 1 || nameLength > 64) errors.push("commanderName must contain 1-64 characters");
    this.validateAsset("gold", save.gold, 1_000_000_000, errors);
    this.validateAsset("dust", save.dust, 1_000_000_000, errors);
    const packEntries = this.entriesOf(save.packs, "packs", errors);
    if (packEntries.length > 100) errors.push("packs contains too many pack IDs");
    for (const [packId, count] of packEntries) this.validateAsset(`packs.${packId}`, count, 1_000_000, errors);
    const entries = this.entriesOf(save.collection, "collection", errors);
    if (entries.length > 1_000) errors.push("collection contains too many card IDs");
    for (const [cardId, count] of entries) {
      if (!this.catalog.has(cardId)) errors.push(`unknown card: ${cardId}`);
      if (!Number.isSafeInteger(count) || count < 0 || count > 999) errors.push(`invalid card count: ${cardId}`);
    }
    if (!Array.isArray(save.decks) || save.decks.length > 27) errors.push("decks must contain at most 27 slots");
    const slots = new Set<number>();
    for (const deck of Array.isArray(save.decks) ? save.decks : []) {
      if (typeof deck !== "object" || deck === null || Array.isArray(deck)) {
        errors.push("deck entries must be objects");
        continue;
      }
      if (!Number.isInteger(deck.slot) || deck.slot < 0 || deck.slot >= 27) errors.push(`invalid deck slot: ${deck.slot}`);
      if (slots.has(deck.slot)) errors.push(`duplicate deck slot: ${deck.slot}`);
      slots.add(deck.slot);
      if (typeof deck.name !== "string" || deck.name.length < 1 || deck.name.length > 64) errors.push(`invalid deck name in slot ${deck.slot}`);
      if (deck.format !== "standard" && deck.format !== "wild") errors.push(`invalid deck format in slot ${deck.slot}`);
      if (!Array.isArray(deck.cardIds) || deck.cardIds.length > 60) errors.push(`deck in slot ${deck.slot} contains too many cards`);
      for (const cardId of Array.isArray(deck.cardIds) ? deck.cardIds : []) {
        if (typeof cardId !== "string" || !this.catalog.has(cardId)) errors.push(`unknown card in deck: ${cardId}`);
      }
      if (deck.deckCode !== undefined && (typeof deck.deckCode !== "string" || deck.deckCode.length > 8_192)) errors.push(`invalid deck code in slot ${deck.slot}`);
    }
    if (save.format !== "standard" && save.format !== "wild") errors.push("format must be standard or wild");
    this.validateAsset("record.wins", save.record?.wins, 1_000_000_000, errors);
    this.validateAsset("record.losses", save.record?.losses, 1_000_000_000, errors);
    this.validateAsset("record.draws", save.record?.draws, 1_000_000_000, errors);
    if (save.exportedAt !== undefined && (typeof save.exportedAt !== "string" || Number.isNaN(Date.parse(save.exportedAt)))) {
      errors.push("exportedAt must be an ISO date-time");
    }
    return [...new Set(errors)].slice(0, 500);
  }

  private entriesOf(value: unknown, name: string, errors: string[]): Array<[string, number]> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      errors.push(`${name} must be an object`);
      return [];
    }
    return Object.entries(value) as Array<[string, number]>;
  }

  private validateAsset(name: string, value: number | undefined, max: number, errors: string[]): void {
    if (!Number.isSafeInteger(value) || (value ?? -1) < 0 || (value ?? max + 1) > max) {
      errors.push(`${name} must be a non-negative safe integer no greater than ${max}`);
    }
  }

  private buildDiff(player: PlayerView, save: LegacyFlutterSaveV1): AssetDiff[] {
    const fields: Array<[string, unknown, unknown]> = [
      ["commanderName", player.commanderName, save.commanderName],
      ["gold", player.gold, save.gold],
      ["dust", player.dust, save.dust],
      ["packs", player.packs, save.packs],
      ["collection", player.collection, save.collection],
      ["decks", player.decks, save.decks],
      ["format", player.format, save.format],
      ["stats", player.stats, save.record],
    ];
    return fields
      .filter(([, before, after]) => canonicalJson(before) !== canonicalJson(after))
      .map(([field, before, after]) => ({ field, before: asJson(before), after: asJson(after) }));
  }
}
