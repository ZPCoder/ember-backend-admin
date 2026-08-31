import { ChannelRegistry } from "./channel.ts";
import { assertService } from "./errors.ts";
import { assertProtocolVersion, fingerprint } from "./runtime.ts";
import type { BackendStore } from "./store.ts";
import type { CommandEnvelope, DeckView, PlayerCommand, PlayerView, SessionPrincipal } from "./types.ts";

export interface CardCatalog {
  has(cardId: string): boolean;
}

export class SetCardCatalog implements CardCatalog {
  private readonly cardIds: Set<string>;

  constructor(cardIds: Iterable<string>) {
    this.cardIds = new Set(cardIds);
  }

  has(cardId: string): boolean {
    return this.cardIds.has(cardId);
  }
}

export class PlayerService {
  private readonly store: BackendStore;
  private readonly channels: ChannelRegistry;
  private readonly catalog: CardCatalog;

  constructor(store: BackendStore, channels: ChannelRegistry, catalog: CardCatalog) {
    this.store = store;
    this.channels = channels;
    this.catalog = catalog;
  }

  async get(principal: SessionPrincipal): Promise<PlayerView> {
    const player = await this.store.getPlayer(principal.playerId);
    assertService(player, 404, "PLAYER_NOT_FOUND", "player does not exist");
    return player;
  }

  async command(principal: SessionPrincipal, envelope: CommandEnvelope<PlayerCommand>): Promise<PlayerView> {
    this.validateEnvelope(envelope);
    const command = envelope.command;
    if (command.type === "set-commander-name") {
      const name = command.commanderName.trim();
      assertService(name.length >= 1 && name.length <= 64, 422, "INVALID_COMMANDER_NAME", "commander name must contain 1-64 characters");
      const adapter = this.channels.get(principal.provider);
      if (adapter.capabilities.supportsSensitiveWords) {
        assertService(!(await adapter.containsSensitiveWords(name)), 422, "SENSITIVE_COMMANDER_NAME", "commander name was rejected by the channel");
      }
    }
    if (command.type === "save-deck") this.validateDeck(command.deck);
    if (command.type === "delete-deck") {
      assertService(Number.isInteger(command.slot) && command.slot >= 0 && command.slot < 27, 422, "INVALID_DECK_SLOT", "deck slot must be between 0 and 26");
    }
    return this.store.applyPlayerCommand(principal.playerId, envelope, await fingerprint(envelope));
  }

  private validateEnvelope(envelope: CommandEnvelope<PlayerCommand>): void {
    assertProtocolVersion(envelope.protocolVersion);
    assertService(envelope.requestId.trim().length > 0, 400, "REQUEST_ID_REQUIRED", "request ID is required");
    assertService(envelope.idempotencyKey.trim().length >= 8, 400, "IDEMPOTENCY_KEY_REQUIRED", "idempotency key must contain at least 8 characters");
    assertService(Number.isSafeInteger(envelope.expectedVersion) && envelope.expectedVersion >= 0, 400, "INVALID_EXPECTED_VERSION", "expected version is invalid");
  }

  private validateDeck(deck: DeckView): void {
    assertService(Number.isInteger(deck.slot) && deck.slot >= 0 && deck.slot < 27, 422, "INVALID_DECK_SLOT", "deck slot must be between 0 and 26");
    assertService(deck.name.trim().length >= 1 && deck.name.trim().length <= 64, 422, "INVALID_DECK_NAME", "deck name must contain 1-64 characters");
    assertService(deck.format === "standard" || deck.format === "wild", 422, "INVALID_DECK_FORMAT", "deck format is invalid");
    assertService((deck.deckCode ?? "").length <= 8192, 422, "INVALID_DECK_CODE", "deck code is too long");
    assertService(deck.cardIds.length <= 60, 422, "INVALID_DECK_SIZE", "deck must contain at most 60 cards");
    for (const cardId of deck.cardIds) {
      assertService(this.catalog.has(cardId), 422, "UNKNOWN_CARD", `unknown card: ${cardId}`);
    }
  }
}
