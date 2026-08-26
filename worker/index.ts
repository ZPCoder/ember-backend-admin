/** Cloudflare Worker entry point for 余烬协议. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import {
  CARD_BY_ID,
  CARD_CATALOG,
  DEFAULT_CARD_BACK_ID,
  HIDDEN_MMR_START,
  MATCHMAKING_WINDOW_INITIAL,
  MATCHMAKING_WINDOW_MAX,
  MATCHMAKING_WINDOW_STEP,
  MATCHMAKING_WINDOW_STEP_MS,
  MAX_HAND_SIZE,
  applyCommand,
  apprenticeMatchPoolForFacts,
  createMatch,
  collectionWithTrialCards,
  initialHiddenMmrForVisibleRating,
  getLadderReadyCatalog,
  ladderReadyDeckMatches,
  ladderReadyDecksForTrial,
  ladderReadyTrialIsActive,
  isCardBackId,
  matchQualityForGap,
  normalizeHiddenMmr,
  normalizeOwnedCardBackId,
  normalizeFavoriteCardBackIds,
  normalizeRankedRewardState,
  resolveCardBackSelection,
  updateHiddenMmrPair,
  validateDeckForFormat,
  type BattleCommand,
  type BattleTarget,
  type ApprenticeMatchPool,
  type MatchQuality,
  type MatchState,
  type RankedFormat,
} from "../lib/game/index.ts";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

type PvpStatement = {
  bind(...values: unknown[]): PvpStatement;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<{ meta?: { changes?: number; last_row_id?: number } }>;
};

type PvpDatabase = {
  prepare(query: string): PvpStatement;
  batch(statements: PvpStatement[]): Promise<unknown>;
};

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

type PvpMessage = Record<string, unknown>;
type PvpPeer = {
  socket?: WebSocket;
  clientId: string;
  identityKey?: string;
  id: string;
  name: string;
  room: string | null;
  queue?: PvpMessage[];
};
type PvpRoom = {
  code: string;
  format: "ranked" | "casual";
  rankedFormat: RankedFormat;
  peers: PvpPeer[];
  nextSequence: number;
  readyDecks: Map<string, string[]>;
  readyCardBacks: Map<string, string>;
  matchState?: MatchState;
  matchToken?: string;
  matchUpdatedAt?: number;
};

const pvpRooms = new Map<string, PvpRoom>();
const pvpPeers = new Map<WebSocket, PvpPeer>();
const pvpPollSessions = new Map<string, PvpPeer>();
const pvpQueues = new Map<string, PvpPeer[]>();
const pvpAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ";

type PvpDbSession = {
  client_id: string;
  player_id: string;
  name: string;
  room_code: string | null;
  updated_at: number;
};
type PvpDbRoom = { code: string; host_client_id: string; guest_client_id: string | null; next_sequence: number; format: "ranked" | "casual"; ranked_format: RankedFormat };
type PvpDbReady = { client_id: string; room_code: string; deck_json: string; updated_at: number };
type PvpDbMatch = { room_code: string; match_token: string; state_json: string; format: "ranked" | "casual"; ranked_format: RankedFormat; created_at: number; updated_at: number };
type PvpDbParticipant = { match_token: string; room_code: string; host_identity: string; guest_identity: string; created_at: number };
type PvpDbQueue = { client_id: string; player_id: string; name: string; format: "ranked" | "casual"; ranked_format: RankedFormat; pool: ApprenticeMatchPool; rating: number; joined_at: number; updated_at: number };
type PvpMatchProfile = { mmr: number; pool: ApprenticeMatchPool };
type PvpRatingPool = RankedFormat | "shared";
type PvpMmrRating = { identity_key: string; mode: "ranked" | "casual"; rating_pool: PvpRatingPool; rating: number; games: number; updated_at: number };
type PvpMmrSettlement = {
  match_token: string;
  mode: "ranked" | "casual";
  rating_pool: PvpRatingPool;
  host_identity: string;
  guest_identity: string;
  winner: 0 | 1 | null;
  host_rating_before: number;
  guest_rating_before: number;
  host_games_before: number;
  guest_games_before: number;
  host_rating_after: number;
  guest_rating_after: number;
  host_games_after: number;
  guest_games_after: number;
  applied: number;
  created_at: number;
};

const PVP_SESSION_TTL_MS = 30 * 60 * 1000;
const PVP_MATCH_ARCHIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PVP_MMR_SETTLEMENT_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const PVP_MAX_BODY_BYTES = 32 * 1024;
// The client renders the countdown, but the Worker must enforce the same
// window so a backgrounded or disconnected tab cannot hold a live turn open.
const PVP_TURN_TIME_LIMIT_MS = 75 * 1000;

function createAuthoritativePvpSeed(): number {
  // The room creator must not be able to search for a favorable opening hand
  // by supplying a client-controlled seed. Generate and retain it inside the
  // Worker; clients receive a redacted authoritative opening snapshot instead
  // of the seed that determines future draws.
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return random[0] & 0x7fffffff;
}

function createAuthoritativeStartingPlayer(): 0 | 1 {
  const random = new Uint8Array(1);
  crypto.getRandomValues(random);
  return (random[0] & 1) as 0 | 1;
}

function redactPvpStateForViewer(state: MatchState, viewer: 0 | 1): MatchState {
  const snapshot = JSON.parse(JSON.stringify(state)) as MatchState;
  // MatchState is a public rendering snapshot, not a replay seed. Both the
  // seed and the evolving RNG state would let a client predict future draws.
  snapshot.seed = 0;
  snapshot.rngState = 0;
  // createMatch's default id embeds the seed in hexadecimal form.
  snapshot.id = "public-match";
  snapshot.players = snapshot.players.map((player, index) => {
    const coinIndex = player.hand.indexOf("the-coin");
    const privateCards = index === viewer
      ? player.hand
      : (player.hand ?? []).map(() => "__hidden-card__");
    if (index === viewer) {
      return {
        ...player,
        // Even the owner must not receive the authoritative future draw order.
        deck: (player.deck ?? []).map(() => "__hidden-card__"),
        deckStartedInDeck: (player.deck ?? []).map(() => true),
        deckEntityIds: (player.deck ?? []).map((_, deckIndex) => `hidden-deck-${deckIndex}`),
        hand: privateCards,
        handCostReductions: [...(player.handCostReductions ?? player.hand.map(() => 0))],
        handFragments: (player.handFragments ?? player.hand.map(() => null)).map((fragment) =>
          fragment ? { ...fragment } : null),
        handEnteredTurns: [...(player.handEnteredTurns ?? player.hand.map(() => 0))],
        handEntityIds: [...(player.handEntityIds ?? player.hand.map((_, index) => `legacy-hand-${index}`))],
      };
    }
    return {
      ...player,
      // Counts are enough for the opponent UI; card identities must remain
      // server-side until a card is publicly played.
      deck: (player.deck ?? []).map(() => "__hidden-card__"),
      deckStartedInDeck: (player.deck ?? []).map(() => true),
      deckEntityIds: (player.deck ?? []).map((_, deckIndex) => `hidden-deck-${deckIndex}`),
      hand: privateCards,
      handCostReductions: privateCards.map(() => 0),
      handFragments: privateCards.map(() => null),
      handStartedInDeck: privateCards.map(() => true),
      handEnteredTurns: privateCards.map(() => 0),
      handEntityIds: privateCards.map((_, index) => `hidden-hand-${index}`),
      coinEntityId: coinIndex >= 0 ? `hidden-hand-${coinIndex}` : undefined,
      // The ordered spell identity history can reveal an untriggered Secret.
      // Keep the complete list server-side for recast effects.
      spellsPlayedThisGame: [],
      spellsPlayedEntityIds: [],
      spellsPlayedFromStartingDeck: [],
      cardGraveyard: [],
      secrets: (player.secrets ?? []).map((_, secretIndex) => ({
        entityId: `hidden-secret-${secretIndex}`,
        cardId: `hidden-secret-${secretIndex}`,
        secretId: `hidden-secret-${secretIndex}`,
        name: "未知奥秘",
        description: "等待敌方行为触发。",
        trigger: "opponent-plays-spell" as const,
        effect: { kind: "armor" as const, amount: 0 },
      })),
    };
  }) as [MatchState["players"][0], MatchState["players"][1]];

  if (snapshot.discover && snapshot.discover.player !== viewer) {
    snapshot.discover = {
      player: snapshot.discover.player,
      sourceCardId: "",
      choices: [],
    };
  }
  if (snapshot.chooseOne && snapshot.chooseOne.player !== viewer) {
    snapshot.chooseOne = {
      player: snapshot.chooseOne.player,
      sourceCardId: "",
      options: [],
    };
  }

  snapshot.events = snapshot.events.map((event) => {
    // Older match-start events contain the authoritative seed. Strip all RNG
    // fields before applying per-player event redaction.
    const safeEvent = event.data && (
      "seed" in event.data ||
      "rngState" in event.data ||
      "deck" in event.data ||
      "deckIds" in event.data ||
      "deckOrder" in event.data
    )
      ? (() => {
          const data = { ...event.data };
          delete data.seed;
          delete data.rngState;
          delete data.deck;
          delete data.deckIds;
          delete data.deckOrder;
          return { ...event, data };
        })()
      : event;
    if (safeEvent.player === viewer) return safeEvent;
    if (
      safeEvent.type === "card-played" &&
      typeof safeEvent.data?.cardId === "string" &&
      isSecretCard(safeEvent.data.cardId)
    ) {
      const safeData = { ...(safeEvent.data ?? {}) };
      delete safeData.cardId;
      delete safeData.target;
      delete safeData.handEntityId;
      return {
        ...safeEvent,
        message: "对手设置了一个奥秘。",
        data: safeData,
      };
    }
    if (safeEvent.type === "secret-armed") {
      return {
        ...safeEvent,
        message: `玩家 ${safeEvent.player ?? 1} 设置了一个奥秘。`,
        data: undefined,
      };
    }
    if (
      safeEvent.type === "spell-recast"
      && typeof safeEvent.data?.cardId === "string"
      && isSecretCard(safeEvent.data.cardId)
    ) {
      const safeData = { ...(safeEvent.data ?? {}) };
      delete safeData.cardId;
      delete safeData.target;
      return {
        ...safeEvent,
        message: "对手重施放并设置了一个奥秘。",
        data: safeData,
      };
    }
    // A card burned by an actual draw is public match-history information.
    // Failed Discover/generate/copy attempts stay private to the hand owner.
    if (safeEvent.type === "card-burned" && safeEvent.data?.overdraw === true) {
      return safeEvent;
    }
    if (
      safeEvent.type === "card-drawn"
      || safeEvent.type === "card-added"
      || safeEvent.type === "card-burned"
      || safeEvent.type === "card-copied"
      || safeEvent.type === "card-traded"
      || safeEvent.type === "card-prepared"
    ) {
      const safeData = { ...(safeEvent.data ?? {}) };
      delete safeData.cardId;
      delete safeData.retainedCostReduction;
      delete safeData.fragment;
      delete safeData.groupId;
      delete safeData.handEntityId;
      delete safeData.entityId;
      return {
        ...safeEvent,
        message: safeEvent.type === "card-traded"
          ? "对手完成了一次可交易循环。"
          : safeEvent.type === "card-prepared"
            ? "对手完成了一次预备。"
          : safeEvent.type === "card-added"
            ? "对手将一张生成牌加入手牌。"
          : safeEvent.type === "card-copied"
            ? "对手复制了一张牌。"
          : safeEvent.type === "card-drawn"
            ? "对手抽取了一张牌。"
            : "对手的一张牌因手牌已满被销毁。",
        data: safeData,
      };
    }
    if (
      safeEvent.type === "card-shattered"
      || safeEvent.type === "card-reassembled"
    ) {
      return {
        ...safeEvent,
        message: safeEvent.type === "card-shattered"
          ? "对手的一张牌裂成碎片并移向手牌两端。"
          : "对手的两片破碎卡牌已经重组。",
        data: undefined,
      };
    }
    if (safeEvent.type === "discover-started") {
      return {
        ...safeEvent,
        message: "对手正在发现一张卡牌。",
        data: undefined,
      };
    }
    if (safeEvent.type === "discover-chosen") {
      return {
        ...safeEvent,
        message: "对手完成了发现选择。",
        data: undefined,
      };
    }
    if (safeEvent.type === "choose-one-started") {
      return {
        ...safeEvent,
        message: "对手正在完成抉择。",
        data: undefined,
      };
    }
    if (safeEvent.type === "choose-one-chosen") {
      return {
        ...safeEvent,
        message: "对手完成了抉择。",
        data: undefined,
      };
    }
    return safeEvent;
  });
  return snapshot;
}

function isSecretCard(cardId: string): boolean {
  return Boolean(CARD_BY_ID[cardId]?.effect?.some((effect) => effect.kind === "secret"));
}

function redactPvpCommandForViewer(command: BattleCommand, viewer: 0 | 1): BattleCommand {
  if (command.player === viewer) return command;
  if (command.type === "play-card" && isSecretCard(command.cardId)) {
    return { ...command, cardId: "__hidden-secret__", target: undefined };
  }
  if (command.type === "choose-discover") {
    return { ...command, cardId: "__hidden-card__", choiceIndex: undefined };
  }
  if (command.type === "trade-card" || command.type === "prepare-card") {
    return { ...command, cardId: "__hidden-card__", handIndex: undefined };
  }
  if (command.type === "choose-one") {
    return { ...command, optionIndex: -1 };
  }
  return command;
}

let pvpSchemaReady: Promise<void> | null = null;

function getPvpDatabase(env: Env): PvpDatabase | null {
  return (env as unknown as { DB?: PvpDatabase }).DB ?? null;
}

async function ensurePvpSchema(db: PvpDatabase): Promise<void> {
  if (!pvpSchemaReady) {
    pvpSchemaReady = db.batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS pvp_sessions (
        client_id TEXT PRIMARY KEY NOT NULL,
        player_id TEXT NOT NULL,
        name TEXT NOT NULL,
        room_code TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`),
      db.prepare(`CREATE INDEX IF NOT EXISTS pvp_sessions_updated_idx ON pvp_sessions (updated_at)`),
      db.prepare(`CREATE TABLE IF NOT EXISTS pvp_rooms (
        code TEXT PRIMARY KEY NOT NULL,
        host_client_id TEXT NOT NULL,
        guest_client_id TEXT,
        format TEXT NOT NULL DEFAULT 'ranked' CHECK (format IN ('ranked', 'casual')),
        ranked_format TEXT NOT NULL DEFAULT 'standard' CHECK (ranked_format IN ('standard', 'wild')),
        next_sequence INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS pvp_messages (
        message_id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`),
      db.prepare(`CREATE INDEX IF NOT EXISTS pvp_messages_client_cursor_idx ON pvp_messages (client_id, message_id)`),
      db.prepare(`CREATE TABLE IF NOT EXISTS pvp_ready (
        client_id TEXT PRIMARY KEY NOT NULL,
        room_code TEXT NOT NULL,
        deck_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`),
      db.prepare(`CREATE INDEX IF NOT EXISTS pvp_ready_room_idx ON pvp_ready (room_code)`),
      db.prepare(`CREATE TABLE IF NOT EXISTS pvp_matches (
        room_code TEXT PRIMARY KEY NOT NULL,
        match_token TEXT NOT NULL,
        state_json TEXT NOT NULL,
        format TEXT NOT NULL DEFAULT 'ranked' CHECK (format IN ('ranked', 'casual')),
        ranked_format TEXT NOT NULL DEFAULT 'standard' CHECK (ranked_format IN ('standard', 'wild')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS pvp_match_archives (
        match_token TEXT PRIMARY KEY NOT NULL,
        state_json TEXT NOT NULL,
        format TEXT NOT NULL DEFAULT 'ranked' CHECK (format IN ('ranked', 'casual')),
        ranked_format TEXT NOT NULL DEFAULT 'standard' CHECK (ranked_format IN ('standard', 'wild')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS pvp_session_identities (
        client_id TEXT PRIMARY KEY NOT NULL,
        identity_key TEXT NOT NULL
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS pvp_match_participants (
        match_token TEXT PRIMARY KEY NOT NULL,
        room_code TEXT NOT NULL,
        host_identity TEXT NOT NULL,
        guest_identity TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`),
      db.prepare(`CREATE INDEX IF NOT EXISTS pvp_match_participants_created_idx ON pvp_match_participants (created_at)`),
      db.prepare(`CREATE TABLE IF NOT EXISTS pvp_queue (
        client_id TEXT PRIMARY KEY NOT NULL,
        player_id TEXT NOT NULL,
        name TEXT NOT NULL,
        format TEXT NOT NULL CHECK (format IN ('ranked', 'casual')),
        ranked_format TEXT NOT NULL DEFAULT 'standard' CHECK (ranked_format IN ('standard', 'wild')),
        pool TEXT NOT NULL DEFAULT 'standard' CHECK (pool IN ('apprentice', 'standard')),
        rating INTEGER NOT NULL DEFAULT 1500,
        joined_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`),
      db.prepare(`CREATE INDEX IF NOT EXISTS pvp_queue_format_joined_idx ON pvp_queue (format, joined_at)`),
      db.prepare(`CREATE TABLE IF NOT EXISTS pvp_matchmaking_ratings (
        identity_key TEXT NOT NULL,
        format TEXT NOT NULL CHECK (format IN ('ranked', 'casual')),
        rating INTEGER NOT NULL DEFAULT 1500,
        games INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (identity_key, format)
      )`),
      db.prepare(`CREATE INDEX IF NOT EXISTS pvp_matchmaking_ratings_format_rating_idx ON pvp_matchmaking_ratings (format, rating)`),
      db.prepare(`CREATE TABLE IF NOT EXISTS pvp_mmr_settlements (
        match_token TEXT PRIMARY KEY NOT NULL,
        format TEXT NOT NULL CHECK (format IN ('ranked', 'casual')),
        host_identity TEXT NOT NULL,
        guest_identity TEXT NOT NULL,
        winner INTEGER CHECK (winner IN (0, 1) OR winner IS NULL),
        host_rating_before INTEGER NOT NULL,
        guest_rating_before INTEGER NOT NULL,
        host_games_before INTEGER NOT NULL,
        guest_games_before INTEGER NOT NULL,
        host_rating_after INTEGER NOT NULL,
        guest_rating_after INTEGER NOT NULL,
        host_games_after INTEGER NOT NULL,
        guest_games_after INTEGER NOT NULL,
        applied INTEGER NOT NULL DEFAULT 0 CHECK (applied IN (0, 1)),
        created_at INTEGER NOT NULL
      )`),
      db.prepare(`CREATE INDEX IF NOT EXISTS pvp_mmr_settlements_created_idx ON pvp_mmr_settlements (created_at)`),
      db.prepare(`CREATE TABLE IF NOT EXISTS pvp_format_matchmaking_ratings (
        identity_key TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('ranked', 'casual')),
        rating_pool TEXT NOT NULL CHECK (rating_pool IN ('standard', 'wild', 'shared')),
        rating INTEGER NOT NULL DEFAULT 1500,
        games INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (identity_key, mode, rating_pool)
      )`),
      db.prepare(`CREATE INDEX IF NOT EXISTS pvp_format_ratings_pool_rating_idx ON pvp_format_matchmaking_ratings (mode, rating_pool, rating)`),
      db.prepare(`CREATE TABLE IF NOT EXISTS pvp_format_mmr_settlements (
        match_token TEXT PRIMARY KEY NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('ranked', 'casual')),
        rating_pool TEXT NOT NULL CHECK (rating_pool IN ('standard', 'wild', 'shared')),
        host_identity TEXT NOT NULL,
        guest_identity TEXT NOT NULL,
        winner INTEGER CHECK (winner IN (0, 1) OR winner IS NULL),
        host_rating_before INTEGER NOT NULL,
        guest_rating_before INTEGER NOT NULL,
        host_games_before INTEGER NOT NULL,
        guest_games_before INTEGER NOT NULL,
        host_rating_after INTEGER NOT NULL,
        guest_rating_after INTEGER NOT NULL,
        host_games_after INTEGER NOT NULL,
        guest_games_after INTEGER NOT NULL,
        applied INTEGER NOT NULL DEFAULT 0 CHECK (applied IN (0, 1)),
        created_at INTEGER NOT NULL
      )`),
      db.prepare(`CREATE INDEX IF NOT EXISTS pvp_format_mmr_settlements_created_idx ON pvp_format_mmr_settlements (created_at)`),
    ]).then(async () => {
      // Existing D1 rooms/matches predate the format split. Migrations are
      // intentionally idempotent so rolling deploys keep old rooms playable.
      try { await db.prepare(`ALTER TABLE pvp_rooms ADD COLUMN format TEXT NOT NULL DEFAULT 'ranked'`).run(); } catch { /* already present */ }
      try { await db.prepare(`ALTER TABLE pvp_matches ADD COLUMN format TEXT NOT NULL DEFAULT 'ranked'`).run(); } catch { /* already present */ }
      for (const table of ["pvp_rooms", "pvp_matches", "pvp_match_archives", "pvp_queue"] as const) {
        try { await db.prepare(`ALTER TABLE ${table} ADD COLUMN ranked_format TEXT NOT NULL DEFAULT 'standard'`).run(); } catch { /* already present */ }
      }
      try { await db.prepare(`ALTER TABLE pvp_queue ADD COLUMN rating INTEGER NOT NULL DEFAULT 1500`).run(); } catch { /* already present */ }
      try { await db.prepare(`ALTER TABLE pvp_queue ADD COLUMN pool TEXT NOT NULL DEFAULT 'standard' CHECK (pool IN ('apprentice', 'standard'))`).run(); } catch { /* already present */ }
      await db.prepare(`CREATE INDEX IF NOT EXISTS pvp_queue_format_pool_joined_idx ON pvp_queue (format, pool, joined_at)`).run();
      await db.prepare(`CREATE INDEX IF NOT EXISTS pvp_queue_format_pool_rating_joined_idx ON pvp_queue (format, pool, rating, joined_at)`).run();
      await db.prepare(`CREATE INDEX IF NOT EXISTS pvp_queue_mode_ranked_pool_rating_idx ON pvp_queue (format, ranked_format, pool, rating, joined_at)`).run();
      await db.prepare(`INSERT OR IGNORE INTO pvp_format_matchmaking_ratings
          (identity_key, mode, rating_pool, rating, games, updated_at)
        SELECT identity_key, format,
               CASE WHEN format = 'casual' THEN 'shared' ELSE 'standard' END,
               rating, games, updated_at
        FROM pvp_matchmaking_ratings`).run();
      try { await db.prepare(`PRAGMA optimize`).run(); } catch { /* optional planner maintenance */ }
    }).catch((error) => {
      pvpSchemaReady = null;
      throw error;
    });
  }
  await pvpSchemaReady;
}

function parsePvpPayload(value: unknown): PvpMessage | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as PvpMessage : null;
  } catch {
    return null;
  }
}

async function queuePvpDbMessage(db: PvpDatabase, clientId: string, message: PvpMessage): Promise<void> {
  await db.prepare(`INSERT INTO pvp_messages (client_id, payload_json, created_at) VALUES (?, ?, ?)`)
    .bind(clientId, JSON.stringify(message), Date.now())
    .run();
}

async function getPvpDbSession(db: PvpDatabase, clientId: string): Promise<PvpDbSession | null> {
  return db.prepare(`SELECT client_id, player_id, name, room_code, updated_at FROM pvp_sessions WHERE client_id = ?`)
    .bind(clientId).first<PvpDbSession>();
}

async function getPvpDbIdentity(db: PvpDatabase, clientId: string): Promise<string> {
  const row = await db.prepare(`SELECT identity_key FROM pvp_session_identities WHERE client_id = ?`)
    .bind(clientId).first<{ identity_key: string }>();
  return row?.identity_key ?? "";
}

async function getPvpDbRoom(db: PvpDatabase, code: string): Promise<PvpDbRoom | null> {
  return db.prepare(`SELECT code, host_client_id, guest_client_id, next_sequence,
      COALESCE(format, 'ranked') AS format,
      COALESCE(ranked_format, 'standard') AS ranked_format
    FROM pvp_rooms WHERE code = ?`)
    .bind(code).first<PvpDbRoom>();
}

async function getPvpDbReady(db: PvpDatabase, clientId: string): Promise<PvpDbReady | null> {
  return db.prepare(`SELECT client_id, room_code, deck_json, updated_at FROM pvp_ready WHERE client_id = ?`)
    .bind(clientId).first<PvpDbReady>();
}

async function getPvpDbMatch(db: PvpDatabase, roomCode: string): Promise<PvpDbMatch | null> {
  return db.prepare(`SELECT room_code, match_token, state_json,
      COALESCE(format, 'ranked') AS format,
      COALESCE(ranked_format, 'standard') AS ranked_format,
      created_at, updated_at FROM pvp_matches WHERE room_code = ?`)
    .bind(roomCode).first<PvpDbMatch>();
}

async function getPvpDbParticipant(db: PvpDatabase, matchToken: string): Promise<PvpDbParticipant | null> {
  return db.prepare(`SELECT match_token, room_code, host_identity, guest_identity, created_at
      FROM pvp_match_participants WHERE match_token = ?`)
    .bind(matchToken).first<PvpDbParticipant>();
}

function pvpParticipantIsValid(participant: PvpDbParticipant | null, match: PvpDbMatch): participant is PvpDbParticipant {
  return Boolean(
    participant &&
    participant.match_token === match.match_token &&
    participant.room_code === match.room_code &&
    participant.host_identity &&
    participant.guest_identity &&
    participant.host_identity !== participant.guest_identity
  );
}

async function getPvpHiddenMmr(
  db: PvpDatabase,
  identityKey: string,
  format: "ranked" | "casual",
  rankedFormat: RankedFormat,
  visibleRating = 1000,
): Promise<PvpMmrRating> {
  const ratingPool: PvpRatingPool = format === "casual" ? "shared" : rankedFormat;
  const load = () => db.prepare(`SELECT identity_key, mode, rating_pool, rating, games, updated_at
      FROM pvp_format_matchmaking_ratings WHERE identity_key = ? AND mode = ? AND rating_pool = ?`)
    .bind(identityKey, format, ratingPool).first<PvpMmrRating>();
  const existing = await load();
  if (existing) {
    return {
      ...existing,
      rating: normalizeHiddenMmr(Number(existing.rating)),
      games: Math.max(0, Math.floor(Number(existing.games) || 0)),
    };
  }
  const now = Date.now();
  const initialRating = initialHiddenMmrForVisibleRating(visibleRating);
  await db.prepare(`INSERT INTO pvp_format_matchmaking_ratings (identity_key, mode, rating_pool, rating, games, updated_at)
      VALUES (?, ?, ?, ?, 0, ?) ON CONFLICT(identity_key, mode, rating_pool) DO NOTHING`)
    .bind(identityKey, format, ratingPool, initialRating, now).run();
  return await load() ?? {
    identity_key: identityKey,
    mode: format,
    rating_pool: ratingPool,
    rating: initialRating,
    games: 0,
    updated_at: now,
  };
}

async function applyPvpMmrSettlement(
  db: PvpDatabase,
  settlement: PvpMmrSettlement,
  now = Date.now(),
): Promise<void> {
  if (settlement.applied === 1) return;
  await db.batch([
    db.prepare(`UPDATE pvp_format_matchmaking_ratings SET rating = ?, games = ?, updated_at = ?
      WHERE identity_key = ? AND mode = ? AND rating_pool = ? AND rating = ? AND games = ?
        AND EXISTS (SELECT 1 FROM pvp_format_mmr_settlements WHERE match_token = ? AND applied = 0)
        AND EXISTS (
          SELECT 1 FROM pvp_format_matchmaking_ratings
          WHERE identity_key = ? AND mode = ? AND rating_pool = ? AND rating = ? AND games = ?
        )`)
      .bind(
        settlement.host_rating_after,
        settlement.host_games_after,
        now,
        settlement.host_identity,
        settlement.mode,
        settlement.rating_pool,
        settlement.host_rating_before,
        settlement.host_games_before,
        settlement.match_token,
        settlement.guest_identity,
        settlement.mode,
        settlement.rating_pool,
        settlement.guest_rating_before,
        settlement.guest_games_before,
      ),
    db.prepare(`UPDATE pvp_format_matchmaking_ratings SET rating = ?, games = ?, updated_at = ?
      WHERE identity_key = ? AND mode = ? AND rating_pool = ? AND rating = ? AND games = ?
        AND EXISTS (SELECT 1 FROM pvp_format_mmr_settlements WHERE match_token = ? AND applied = 0)
        AND EXISTS (
          SELECT 1 FROM pvp_format_matchmaking_ratings
          WHERE identity_key = ? AND mode = ? AND rating_pool = ? AND rating = ? AND games = ?
        )`)
      .bind(
        settlement.guest_rating_after,
        settlement.guest_games_after,
        now,
        settlement.guest_identity,
        settlement.mode,
        settlement.rating_pool,
        settlement.guest_rating_before,
        settlement.guest_games_before,
        settlement.match_token,
        settlement.host_identity,
        settlement.mode,
        settlement.rating_pool,
        settlement.host_rating_after,
        settlement.host_games_after,
      ),
    db.prepare(`UPDATE pvp_format_mmr_settlements SET applied = 1
      WHERE match_token = ? AND applied = 0
        AND EXISTS (
          SELECT 1 FROM pvp_format_matchmaking_ratings
          WHERE identity_key = ? AND mode = ? AND rating_pool = ? AND rating = ? AND games = ?
        )
        AND EXISTS (
          SELECT 1 FROM pvp_format_matchmaking_ratings
          WHERE identity_key = ? AND mode = ? AND rating_pool = ? AND rating = ? AND games = ?
        )`)
      .bind(
        settlement.match_token,
        settlement.host_identity,
        settlement.mode,
        settlement.rating_pool,
        settlement.host_rating_after,
        settlement.host_games_after,
        settlement.guest_identity,
        settlement.mode,
        settlement.rating_pool,
        settlement.guest_rating_after,
        settlement.guest_games_after,
      ),
  ]);
}

async function applyOrRebasePvpMmrSettlement(
  db: PvpDatabase,
  settlement: PvpMmrSettlement,
  now = Date.now(),
): Promise<void> {
  await applyPvpMmrSettlement(db, settlement, now);
  let pending = await db.prepare(`SELECT * FROM pvp_format_mmr_settlements WHERE match_token = ?`)
    .bind(settlement.match_token).first<PvpMmrSettlement>();
  if (!pending || pending.applied === 1) return;

  // Another match in the same pool may have settled after this immutable row
  // captured its before-values. Rebase an entirely unapplied row onto the
  // latest pair so concurrent finishes cannot leave a match's MMR stranded.
  const rankedFormat: RankedFormat = pending.rating_pool === "wild" ? "wild" : "standard";
  const [host, guest] = await Promise.all([
    getPvpHiddenMmr(db, pending.host_identity, pending.mode, rankedFormat),
    getPvpHiddenMmr(db, pending.guest_identity, pending.mode, rankedFormat),
  ]);
  const [hostAfter, guestAfter] = updateHiddenMmrPair(host, guest, pending.winner);
  await db.prepare(`UPDATE pvp_format_mmr_settlements SET
      host_rating_before = ?, guest_rating_before = ?, host_games_before = ?, guest_games_before = ?,
      host_rating_after = ?, guest_rating_after = ?, host_games_after = ?, guest_games_after = ?
    WHERE match_token = ? AND applied = 0
      AND host_rating_before = ? AND guest_rating_before = ?
      AND host_games_before = ? AND guest_games_before = ?`)
    .bind(
      host.rating,
      guest.rating,
      host.games,
      guest.games,
      hostAfter.rating,
      guestAfter.rating,
      hostAfter.games,
      guestAfter.games,
      pending.match_token,
      pending.host_rating_before,
      pending.guest_rating_before,
      pending.host_games_before,
      pending.guest_games_before,
    ).run();
  pending = await db.prepare(`SELECT * FROM pvp_format_mmr_settlements WHERE match_token = ?`)
    .bind(settlement.match_token).first<PvpMmrSettlement>();
  if (pending) await applyPvpMmrSettlement(db, pending, now);
}

async function settlePvpHiddenMmr(
  db: PvpDatabase,
  match: PvpDbMatch,
  state: MatchState,
  now = Date.now(),
): Promise<void> {
  if (state.phase !== "game-over" || !state.result) return;
  const participant = await getPvpDbParticipant(db, match.match_token);
  if (!pvpParticipantIsValid(participant, match)) return;
  const ratingPool: PvpRatingPool = match.format === "casual" ? "shared" : match.ranked_format;
  const existing = await db.prepare(`SELECT * FROM pvp_format_mmr_settlements WHERE match_token = ?`)
    .bind(match.match_token).first<PvpMmrSettlement>();
  if (existing) {
    if (
      existing.mode === match.format &&
      existing.rating_pool === ratingPool &&
      existing.host_identity === participant.host_identity &&
      existing.guest_identity === participant.guest_identity
    ) {
      await applyOrRebasePvpMmrSettlement(db, existing, now);
    }
    return;
  }

  const [host, guest] = await Promise.all([
    getPvpHiddenMmr(db, participant.host_identity, match.format, match.ranked_format),
    getPvpHiddenMmr(db, participant.guest_identity, match.format, match.ranked_format),
  ]);
  const winner = state.result.winner;
  const [hostAfter, guestAfter] = updateHiddenMmrPair(host, guest, winner);
  await db.prepare(`INSERT INTO pvp_format_mmr_settlements (
      match_token, mode, rating_pool, host_identity, guest_identity, winner,
      host_rating_before, guest_rating_before, host_games_before, guest_games_before,
      host_rating_after, guest_rating_after, host_games_after, guest_games_after,
      applied, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    ON CONFLICT(match_token) DO NOTHING`)
    .bind(
      match.match_token,
      match.format,
      ratingPool,
      participant.host_identity,
      participant.guest_identity,
      winner,
      host.rating,
      guest.rating,
      host.games,
      guest.games,
      hostAfter.rating,
      guestAfter.rating,
      hostAfter.games,
      guestAfter.games,
      now,
    ).run();
  const settlement = await db.prepare(`SELECT * FROM pvp_format_mmr_settlements WHERE match_token = ?`)
    .bind(match.match_token).first<PvpMmrSettlement>();
  if (
    settlement &&
    settlement.mode === match.format &&
    settlement.rating_pool === ratingPool &&
    settlement.host_identity === participant.host_identity &&
    settlement.guest_identity === participant.guest_identity
  ) {
    await applyOrRebasePvpMmrSettlement(db, settlement, now);
  }
}

async function archiveFinishedPvpMatch(
  db: PvpDatabase,
  match: PvpDbMatch,
  state: MatchState,
  now = Date.now(),
): Promise<void> {
  if (state.phase !== "game-over" || !state.result) return;
  await db.prepare(`INSERT INTO pvp_match_archives
      (match_token, state_json, format, ranked_format, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(match_token) DO UPDATE SET
      state_json = excluded.state_json,
      format = excluded.format,
      ranked_format = excluded.ranked_format,
      updated_at = excluded.updated_at`)
    .bind(match.match_token, JSON.stringify(state), match.format, match.ranked_format, match.created_at, now)
    .run();
  await settlePvpHiddenMmr(db, match, state, now);
}

async function getPvpDbQueue(db: PvpDatabase, clientId: string): Promise<PvpDbQueue | null> {
  return db.prepare(`SELECT client_id, player_id, name, format,
      COALESCE(ranked_format, 'standard') AS ranked_format,
      COALESCE(pool, 'standard') AS pool, COALESCE(rating, 1500) AS rating,
      joined_at, updated_at FROM pvp_queue WHERE client_id = ?`)
    .bind(clientId).first<PvpDbQueue>();
}

async function getPvpMatchProfile(
  db: PvpDatabase,
  clientId: string,
  format: "ranked" | "casual",
  rankedFormat: RankedFormat,
): Promise<PvpMatchProfile> {
  const identity = await getPvpDbIdentity(db, clientId);
  if (!identity) return { mmr: HIDDEN_MMR_START, pool: "standard" };
  const row = await db.prepare(`
    SELECT
      COALESCE(
        json_extract(ps.state_json, '$.rankedLadders.${rankedFormat}.rating'),
        json_extract(ps.state_json, '$.ladder.rating'),
        1000
      ) AS rating,
      COALESCE(json_extract(ps.state_json, '$.packPity.packsOpened'), 0) AS packs_opened,
      COALESCE(json_extract(ps.state_json, '$.stats.matchesPlayed'), 0) AS matches_played,
      COALESCE(json_extract(ps.state_json, '$.stats.wins'), 0) AS wins,
      COALESCE(json_extract(ps.state_json, '$.progression.level'), 1) AS level
    FROM players p
    JOIN player_states ps ON ps.player_id = p.id
    WHERE p.identity_key = ?
    LIMIT 1
  `).bind(identity).first<{
    rating: number | string | null;
    packs_opened: number | string | null;
    matches_played: number | string | null;
    wins: number | string | null;
    level: number | string | null;
  }>();
  if (!row) return { mmr: HIDDEN_MMR_START, pool: "standard" };
  const visibleRating = Number(row.rating);
  const hiddenMmr = await getPvpHiddenMmr(
    db,
    identity,
    format,
    rankedFormat,
    Number.isFinite(visibleRating) && visibleRating >= 0 ? visibleRating : 1000,
  );
  const fact = (value: number | string | null, fallback: number) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
  };
  return {
    mmr: hiddenMmr.rating,
    pool: apprenticeMatchPoolForFacts({
      packsOpened: fact(row.packs_opened, 0),
      matchesPlayed: fact(row.matches_played, 0),
      wins: fact(row.wins, 0),
      level: fact(row.level, 1),
    }),
  };
}

function pvpCardCounts(cardIds: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const cardId of cardIds) counts.set(cardId, (counts.get(cardId) ?? 0) + 1);
  return counts;
}

function pvpAccountStateAllowsDeck(
  stateJson: string,
  deckIds: readonly string[],
  rankedFormat: RankedFormat,
): boolean {
  if (!validateDeckForFormat(deckIds, rankedFormat).valid) return false;
  let state: unknown;
  try {
    state = JSON.parse(stateJson);
  } catch {
    return false;
  }
  if (!state || typeof state !== "object" || Array.isArray(state)) return false;
  const raw = state as Record<string, unknown>;
  if (!raw.collection || typeof raw.collection !== "object" || Array.isArray(raw.collection) || !Array.isArray(raw.decks)) {
    return false;
  }
  const collection = raw.collection as Record<string, unknown>;
  const numericCollection = Object.fromEntries(Object.entries(collection).flatMap(([cardId, count]) =>
    typeof count === "number" && Number.isSafeInteger(count) && count >= 0
      ? [[cardId, count]]
      : []));
  const effectiveCollection = collectionWithTrialCards(
    numericCollection,
    (raw.trialCards ?? raw.ladderReady) as { activatedAt: string | null; expiresAt: string | null } | undefined,
    CARD_CATALOG,
  );
  const ownsRequestedCards = [...pvpCardCounts(deckIds)].every(([cardId, count]) => {
    return (effectiveCollection[cardId] ?? 0) >= count;
  });
  const ownsSavedDeck = ownsRequestedCards && raw.decks.some((deck) => {
    if (!deck || typeof deck !== "object" || Array.isArray(deck)) return false;
    const cardIds = (deck as Record<string, unknown>).cardIds;
    return Array.isArray(cardIds) &&
      cardIds.every((cardId) => typeof cardId === "string") &&
      ladderReadyDeckMatches(cardIds as string[], deckIds);
  });
  if (ownsSavedDeck) return true;

  const trial = raw.ladderReady;
  if (!trial || typeof trial !== "object" || Array.isArray(trial)) return false;
  const ladderReady = trial as Record<string, unknown>;
  if (
    typeof ladderReady.activatedAt !== "string" ||
    typeof ladderReady.expiresAt !== "string" ||
    ladderReady.claimedDeckId !== null
  ) {
    return false;
  }
  const catalogVersionId = typeof ladderReady.catalogVersionId === "string"
    ? getLadderReadyCatalog(ladderReady.catalogVersionId)?.id ?? null
    : null;
  if (!ladderReadyTrialIsActive({
    activatedAt: ladderReady.activatedAt,
    expiresAt: ladderReady.expiresAt,
    claimedDeckId: null,
    catalogVersionId,
  })) return false;
  return ladderReadyDecksForTrial({
    activatedAt: ladderReady.activatedAt,
    expiresAt: ladderReady.expiresAt,
    claimedDeckId: null,
    catalogVersionId,
  }).some((deck) => ladderReadyDeckMatches(deck.deck, deckIds));
}

function pvpAccountStateAuthorizesCardBack(
  stateJson: string,
  deckIds: readonly string[],
  rankedFormat: RankedFormat,
  requestedCardBackId: string,
): string | null {
  if (!isCardBackId(requestedCardBackId) || !pvpAccountStateAllowsDeck(stateJson, deckIds, rankedFormat)) return null;
  let state: unknown;
  try {
    state = JSON.parse(stateJson);
  } catch {
    return null;
  }
  if (!state || typeof state !== "object" || Array.isArray(state)) return null;
  const raw = state as Record<string, unknown>;
  const rewards = normalizeRankedRewardState(raw.rankedRewards);
  const savedDecks = Array.isArray(raw.decks) ? raw.decks.filter((deck) => {
    if (!deck || typeof deck !== "object" || Array.isArray(deck)) return false;
    const stored = deck as Record<string, unknown>;
    return Array.isArray(stored.cardIds)
      && stored.cardIds.every((cardId) => typeof cardId === "string")
      && ladderReadyDeckMatches(stored.cardIds as string[], deckIds);
  }) as Array<Record<string, unknown>> : [];
  const matchingDeck = savedDecks.some((stored) =>
    normalizeOwnedCardBackId(stored.cardBackId, rewards) === requestedCardBackId);
  if (matchingDeck) return requestedCardBackId;
  if (savedDecks.length > 0) return null;

  // Unsaved seven-day trial decks have no cosmetic loadout and always use the
  // universally owned default card back.
  return requestedCardBackId === DEFAULT_CARD_BACK_ID ? DEFAULT_CARD_BACK_ID : null;
}

async function pvpAccountAuthorizesLoadout(
  db: PvpDatabase,
  clientId: string,
  deckIds: readonly string[],
  rankedFormat: RankedFormat,
  requestedCardBackId: string,
): Promise<string | null> {
  const row = await db.prepare(`
    SELECT ps.state_json
    FROM pvp_session_identities psi
    JOIN players p ON p.identity_key = psi.identity_key
    JOIN player_states ps ON ps.player_id = p.id
    WHERE psi.client_id = ? AND psi.identity_key <> ''
    LIMIT 1
  `).bind(clientId).first<{ state_json: string }>();
  return row
    ? pvpAccountStateAuthorizesCardBack(row.state_json, deckIds, rankedFormat, requestedCardBackId)
    : null;
}

async function loadPvpCardBackProfile(db: PvpDatabase, clientId: string): Promise<{ rankedRewards: unknown; favoriteCardBackIds: unknown }> {
  const row = await db.prepare(`
    SELECT ps.state_json
    FROM pvp_session_identities psi
    JOIN players p ON p.identity_key = psi.identity_key
    JOIN player_states ps ON ps.player_id = p.id
    WHERE psi.client_id = ? AND psi.identity_key <> ''
    LIMIT 1
  `).bind(clientId).first<{ state_json: string }>();
  if (!row) return { rankedRewards: undefined, favoriteCardBackIds: undefined };
  try {
    const state = JSON.parse(row.state_json) as Record<string, unknown>;
    return { rankedRewards: state.rankedRewards, favoriteCardBackIds: state.favoriteCardBackIds };
  } catch {
    return { rankedRewards: undefined, favoriteCardBackIds: undefined };
  }
}

async function dbLeaveQueue(db: PvpDatabase, session: PvpDbSession): Promise<void> {
  await db.prepare(`DELETE FROM pvp_queue WHERE client_id = ?`).bind(session.client_id).run();
}

async function prunePvpDb(db: PvpDatabase): Promise<void> {
  const cutoff = Date.now() - PVP_SESSION_TTL_MS;
  const archiveCutoff = Date.now() - PVP_MATCH_ARCHIVE_TTL_MS;
  const mmrSettlementCutoff = Date.now() - PVP_MMR_SETTLEMENT_TTL_MS;
  const stale = await db.prepare(`SELECT client_id, player_id, name, room_code, updated_at FROM pvp_sessions WHERE updated_at < ? LIMIT 50`)
    .bind(cutoff).all<PvpDbSession>();
  for (const session of stale.results ?? []) {
    if (!await dbLeaveRoom(db, session)) continue;
    await db.prepare(`DELETE FROM pvp_messages WHERE client_id = ?`).bind(session.client_id).run();
    await db.prepare(`DELETE FROM pvp_session_identities WHERE client_id = ?`).bind(session.client_id).run();
    await db.prepare(`DELETE FROM pvp_sessions WHERE client_id = ?`).bind(session.client_id).run();
  }
  await db.batch([
    db.prepare(`DELETE FROM pvp_messages WHERE created_at < ?`).bind(cutoff),
    db.prepare(`DELETE FROM pvp_ready WHERE updated_at < ?`).bind(cutoff),
    db.prepare(`DELETE FROM pvp_queue WHERE updated_at < ?`).bind(cutoff),
    db.prepare(`DELETE FROM pvp_mmr_settlements WHERE applied = 1 AND created_at < ?`).bind(mmrSettlementCutoff),
    db.prepare(`DELETE FROM pvp_format_mmr_settlements WHERE applied = 1 AND created_at < ?`).bind(mmrSettlementCutoff),
  ]);
  try {
    await db.batch([
    // Terminal proof may be the only way a player who was offline during a
    // forfeit can reconcile their result. Retention expiry is therefore only
    // a minimum: delete after both immutable participant identities have a
    // match record for this token.
    db.prepare(`DELETE FROM pvp_match_archives
      WHERE updated_at < ?
        AND EXISTS (
          SELECT 1
          FROM pvp_match_participants pp
          JOIN players host ON host.identity_key = pp.host_identity
          JOIN match_records host_match
            ON host_match.player_id = host.id AND host_match.pvp_token = pp.match_token
          JOIN players guest ON guest.identity_key = pp.guest_identity
          JOIN match_records guest_match
            ON guest_match.player_id = guest.id AND guest_match.pvp_token = pp.match_token
          WHERE pp.match_token = pvp_match_archives.match_token
            AND pp.host_identity <> pp.guest_identity
        )`).bind(archiveCutoff),
    db.prepare(`DELETE FROM pvp_match_participants
      WHERE created_at < ?
        AND NOT EXISTS (
          SELECT 1 FROM pvp_match_archives archive
          WHERE archive.match_token = pvp_match_participants.match_token
        )
        AND EXISTS (
          SELECT 1
          FROM players host
          JOIN match_records host_match
            ON host_match.player_id = host.id AND host_match.pvp_token = pvp_match_participants.match_token
          JOIN players guest ON guest.identity_key = pvp_match_participants.guest_identity
          JOIN match_records guest_match
            ON guest_match.player_id = guest.id AND guest_match.pvp_token = pvp_match_participants.match_token
          WHERE host.identity_key = pvp_match_participants.host_identity
            AND pvp_match_participants.host_identity <> pvp_match_participants.guest_identity
        )`).bind(archiveCutoff),
    ]);
  } catch {
    // During a rolling migration match_records may not have pvp_token yet.
    // Keeping terminal proof longer is always safer than failing PVP connect
    // or deleting an outcome before it can be reconciled.
  }
}

function parsePvpDeck(value: unknown, rankedFormat: RankedFormat = "wild"): string[] | null {
  if (!Array.isArray(value) || value.length !== 30 || value.some((cardId) => typeof cardId !== "string")) return null;
  const deck = value.map(String);
  return validateDeckForFormat(deck, rankedFormat).valid ? deck : null;
}

function parsePvpReadyLoadout(value: unknown, rankedFormat: RankedFormat): { deckIds: string[]; cardBackId: string } | null {
  if (Array.isArray(value)) {
    const deckIds = parsePvpDeck(value, rankedFormat);
    return deckIds ? { deckIds, cardBackId: DEFAULT_CARD_BACK_ID } : null;
  }
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const deckIds = parsePvpDeck(raw.cardIds, rankedFormat);
  return deckIds && isCardBackId(raw.cardBackId)
    ? { deckIds, cardBackId: raw.cardBackId }
    : null;
}

function parsePvpFormat(value: unknown): "ranked" | "casual" {
  return value === "casual" ? "casual" : "ranked";
}

function parseRankedFormat(value: unknown): RankedFormat {
  return value === "wild" ? "wild" : "standard";
}

function parsePvpState(value: string, rankedFormat: RankedFormat = "standard"): MatchState | null {
  try {
    const parsed = JSON.parse(value) as MatchState;
    return parsed && typeof parsed === "object" && Array.isArray(parsed.players) && typeof parsed.version === "number"
      ? { ...parsed, rankedFormat: parsed.rankedFormat === "wild" ? "wild" : rankedFormat }
      : null;
  } catch {
    return null;
  }
}

async function dbRoomPlayers(db: PvpDatabase, room: PvpDbRoom): Promise<Array<{ id: string; name: string }>> {
  const ids = [room.host_client_id, room.guest_client_id].filter(Boolean) as string[];
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  const result = await db.prepare(`SELECT player_id, name FROM pvp_sessions WHERE client_id IN (${placeholders})`)
    .bind(...ids).all<{ player_id: string; name: string }>();
  return (result.results ?? []).map((row) => ({ id: row.player_id, name: row.name }));
}

async function dbRoomState(db: PvpDatabase, room: PvpDbRoom): Promise<void> {
  const players = await dbRoomPlayers(db, room);
  const payload = {
    type: "room_state",
    room: room.code,
    format: room.format,
    rankedFormat: room.ranked_format,
    payload: { players, format: room.format, rankedFormat: room.ranked_format },
  };
  await Promise.all([room.host_client_id, room.guest_client_id].filter(Boolean).map((clientId) => queuePvpDbMessage(db, clientId as string, payload)));
}

async function clearPvpMatchIfActive(db: PvpDatabase, roomCode: string): Promise<boolean> {
  const match = await getPvpDbMatch(db, roomCode);
  if (!match) return true;
  const state = match ? parsePvpState(match.state_json, match.ranked_format) : null;
  // Archive completed proof before freeing the room's current-match slot.
  // Settlement reads the immutable archive, so a leaver/rematch cannot erase
  // the result and a promoted guest cannot restore the old match as player 0.
  if (state?.phase === "game-over") {
    if (!pvpParticipantIsValid(await getPvpDbParticipant(db, match.match_token), match)) {
      return false;
    }
    await archiveFinishedPvpMatch(db, match, state);
  } else {
    // Never destroy unfinished PVP proof. Ranked changes rating, while casual
    // still changes history/tasks/rewards; both require an authoritative
    // server-side forfeit tied to immutable participant identities.
    return false;
  }
  await db.prepare(`DELETE FROM pvp_matches WHERE room_code = ? AND match_token = ?`)
    .bind(roomCode, match.match_token).run();
  return true;
}

async function ensurePvpParticipantForExistingMatch(
  db: PvpDatabase,
  room: PvpDbRoom,
  match: PvpDbMatch,
): Promise<PvpDbParticipant | null> {
  const existing = await getPvpDbParticipant(db, match.match_token);
  if (existing) return existing;

  // Repair only legacy rows whose current room roles still map to two strong,
  // distinct identities. Never infer ownership from display/player ids.
  const [hostIdentity, guestIdentity] = await Promise.all([
    getPvpDbIdentity(db, room.host_client_id),
    room.guest_client_id ? getPvpDbIdentity(db, room.guest_client_id) : Promise.resolve(""),
  ]);
  if (!hostIdentity || !guestIdentity || hostIdentity === guestIdentity) return null;
  await db.prepare(`INSERT INTO pvp_match_participants
      (match_token, room_code, host_identity, guest_identity, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(match_token) DO NOTHING`)
    .bind(match.match_token, match.room_code, hostIdentity, guestIdentity, match.created_at)
    .run();
  return getPvpDbParticipant(db, match.match_token);
}

async function settlePvpDeparture(
  db: PvpDatabase,
  roomCode: string,
  room: PvpDbRoom | null,
  session: PvpDbSession,
): Promise<boolean> {
  // A command already in flight can win one CAS between reads. Retry against
  // the new snapshot; the first successful terminal update remains final.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const match = await getPvpDbMatch(db, roomCode);
    if (!match) return true;
    const current = parsePvpState(match.state_json, match.ranked_format);
    if (current?.phase === "game-over") {
      const participant = room
        ? await ensurePvpParticipantForExistingMatch(db, room, match)
        : await getPvpDbParticipant(db, match.match_token);
      if (!pvpParticipantIsValid(participant, match)) return false;
      await archiveFinishedPvpMatch(db, match, current);
      return true;
    }
    if (!current) return false;

    const participant = room
      ? await ensurePvpParticipantForExistingMatch(db, room, match)
      : await getPvpDbParticipant(db, match.match_token);
    const leavingIdentity = await getPvpDbIdentity(db, session.client_id);
    if (!pvpParticipantIsValid(participant, match) || !leavingIdentity) return false;
    const identityRole = participant.host_identity === leavingIdentity
      ? 0
      : participant.guest_identity === leavingIdentity
        ? 1
        : null;
    if (identityRole === null) return false;
    if (room && pvpRoleIndex(room, session.client_id) !== identityRole) return false;

    const command: BattleCommand = {
      type: "concede",
      player: identityRole,
      commandId: `server-forfeit-${match.match_token}-${current.version}-${crypto.randomUUID()}`,
    };
    const transition = applyCommand(current, command);
    if (
      !transition.accepted ||
      transition.duplicate ||
      transition.state === current ||
      transition.state.version <= current.version ||
      transition.state.phase !== "game-over"
    ) return false;

    const now = Date.now();
    const updated = await db.prepare(`UPDATE pvp_matches SET state_json = ?, updated_at = ?
        WHERE room_code = ? AND match_token = ? AND state_json = ?`)
      .bind(JSON.stringify(transition.state), now, roomCode, match.match_token, match.state_json)
      .run();
    if ((updated.meta?.changes ?? 0) !== 1) continue;

    await archiveFinishedPvpMatch(db, match, transition.state, now);
    if (room) {
      await broadcastPvpDbTransition(db, room, session, "command", command, transition.state, match.match_token);
    }
    return true;
  }
  return false;
}

async function dbRestoreSession(db: PvpDatabase, session: PvpDbSession): Promise<void> {
  const now = Date.now();
  await db.prepare(`DELETE FROM pvp_messages WHERE client_id = ?`).bind(session.client_id).run();
  await queuePvpDbMessage(db, session.client_id, { type: "welcome", playerId: session.player_id, message: "连接成功" });
  if (!session.room_code) {
    const queued = await getPvpDbQueue(db, session.client_id);
    if (queued) await queuePvpDbMessage(db, session.client_id, {
      type: "queue_joined",
      format: queued.format,
      rankedFormat: queued.ranked_format,
      pool: queued.pool,
      joinedAt: queued.joined_at,
      message: queued.pool === "apprentice"
        ? "新兵保护匹配中，正在按隐藏水平寻找同轨道对手…"
        : `${queued.format === "ranked" ? "天梯" : "休闲"}匹配中，正在按隐藏水平寻找公平对手…`,
    });
    return;
  }
  const room = await getPvpDbRoom(db, session.room_code);
  if (!room) {
    await db.prepare(`UPDATE pvp_sessions SET room_code = NULL, updated_at = ? WHERE client_id = ?`)
      .bind(now, session.client_id).run();
    return;
  }
  const isHost = room.host_client_id === session.client_id;
  await queuePvpDbMessage(db, session.client_id, {
    type: isHost ? "room_created" : "room_joined",
    room: room.code,
    format: room.format,
    rankedFormat: room.ranked_format,
    message: "已恢复房间连接，请双方重新准备。",
  });
  const peerId = isHost ? room.guest_client_id : room.host_client_id;
  if (peerId) {
    const peer = await getPvpDbSession(db, peerId);
    if (peer) {
      await queuePvpDbMessage(db, session.client_id, { type: "peer_joined", peerName: peer.name, playerId: peer.player_id, message: `${peer.name} 已在房间中` });
    }
  }
  await dbRoomState(db, room);
  const match = await getPvpDbMatch(db, room.code);
  const matchState = match ? parsePvpState(match.state_json, match.ranked_format) : null;
  if (match && matchState) {
    const viewer = isHost ? 0 : 1;
    await queuePvpDbMessage(db, session.client_id, {
      type: "match_sync",
      room: room.code,
      payload: { state: redactPvpStateForViewer(matchState, viewer), matchToken: match.match_token, format: room.format, rankedFormat: room.ranked_format },
    });
  }
}

async function dbLeaveRoom(db: PvpDatabase, session: PvpDbSession): Promise<boolean> {
  if (!session.room_code) return true;
  const leavingRoomCode = session.room_code;
  const room = await getPvpDbRoom(db, session.room_code);
  if (!room) {
    await db.prepare(`DELETE FROM pvp_ready WHERE client_id = ?`).bind(session.client_id).run();
    const settled = await settlePvpDeparture(db, leavingRoomCode, null, session);
    const cleared = settled && await clearPvpMatchIfActive(db, leavingRoomCode);
    if (!settled || !cleared) {
      await queuePvpDbMessage(db, session.client_id, { type: "error", message: "服务器未能安全固化当前对局结果，请稍后重试。" });
      return false;
    }
    await db.prepare(`UPDATE pvp_sessions SET room_code = NULL, updated_at = ? WHERE client_id = ?`)
      .bind(Date.now(), session.client_id).run();
    return true;
  }
  // Detach the departing transport first. match_start's transactional guard
  // requires both sessions to remain in this room, so stale concurrent ready
  // or start requests cannot reopen the race after the ready rows are cleared.
  await db.prepare(`UPDATE pvp_sessions SET room_code = NULL, updated_at = ?
      WHERE client_id = ? AND room_code = ?`)
    .bind(Date.now(), session.client_id, room.code).run();
  // Clear both ready rows as a second fence and force any remaining player to
  // prepare again after room ownership/presence changes.
  await db.prepare(`DELETE FROM pvp_ready WHERE room_code = ?`).bind(room.code).run();
  const settled = await settlePvpDeparture(db, room.code, room, session);
  const cleared = settled && await clearPvpMatchIfActive(db, room.code);
  const opponentId = room.host_client_id === session.client_id ? room.guest_client_id : room.host_client_id;
  if (!settled || !cleared) {
    await db.prepare(`UPDATE pvp_sessions SET room_code = ?, updated_at = ? WHERE client_id = ?`)
      .bind(room.code, Date.now(), session.client_id).run();
    await queuePvpDbMessage(db, session.client_id, {
      type: "error",
      message: "服务器未能安全固化当前对局结果；已保留房间，请稍后重试。",
    });
    if (opponentId) {
      await queuePvpDbMessage(db, opponentId, {
        type: "error",
        message: "对手已断开，但服务器未能安全固化对局结果；房间已冻结，请重新连接后重试。",
      });
    }
    return false;
  }
  if (opponentId) {
    const promotesOpponent = room.host_client_id === session.client_id;
    await queuePvpDbMessage(db, opponentId, { type: "peer_left", peerName: session.name, message: `${session.name} 已离开房间` });
    const nextRoom = promotesOpponent
      ? { host: opponentId, guest: null }
      : { host: room.host_client_id, guest: null };
    await db.prepare(`UPDATE pvp_rooms SET host_client_id = ?, guest_client_id = ?, updated_at = ? WHERE code = ?`)
      .bind(nextRoom.host, nextRoom.guest, Date.now(), room.code).run();
    await db.prepare(`UPDATE pvp_sessions SET room_code = NULL, updated_at = ? WHERE client_id = ?`)
      .bind(Date.now(), session.client_id).run();
    await db.prepare(`UPDATE pvp_sessions SET room_code = ? WHERE client_id = ?`).bind(room.code, opponentId).run();
    if (promotesOpponent) {
      await queuePvpDbMessage(db, opponentId, {
        type: "room_created",
        room: room.code,
        format: room.format,
        rankedFormat: room.ranked_format,
        message: "原房主已离开，你现在是房主。",
      });
    }
    const remaining = await getPvpDbRoom(db, room.code);
    if (remaining) await dbRoomState(db, remaining);
  } else {
    await db.prepare(`DELETE FROM pvp_rooms WHERE code = ?`).bind(room.code).run();
    await db.prepare(`UPDATE pvp_sessions SET room_code = NULL, updated_at = ? WHERE client_id = ?`)
      .bind(Date.now(), session.client_id).run();
  }
  return true;
}

async function dbCreateRoom(
  db: PvpDatabase,
  session: PvpDbSession,
  format: "ranked" | "casual",
  rankedFormat: RankedFormat,
): Promise<void> {
  await dbLeaveQueue(db, session);
  if (!await dbLeaveRoom(db, session)) {
    await queuePvpDbMessage(db, session.client_id, { type: "error", message: "当前对局尚未安全结算，暂时不能创建新房间。" });
    return;
  }
  let code = "";
  for (let attempt = 0; attempt < 12; attempt += 1) {
    code = Array.from({ length: 4 }, () => pvpAlphabet[Math.floor(Math.random() * pvpAlphabet.length)]).join("");
    if (!(await getPvpDbRoom(db, code))) break;
  }
  const now = Date.now();
  await db.prepare(`INSERT INTO pvp_rooms (code, host_client_id, guest_client_id, next_sequence, format, ranked_format, created_at, updated_at) VALUES (?, ?, NULL, 0, ?, ?, ?, ?)`)
    .bind(code, session.client_id, format, rankedFormat, now, now).run();
  await db.prepare(`UPDATE pvp_sessions SET room_code = ?, updated_at = ? WHERE client_id = ?`)
    .bind(code, now, session.client_id).run();
  await queuePvpDbMessage(db, session.client_id, { type: "room_created", room: code, format, rankedFormat, message: "房间已创建，等待对手加入" });
  const room = await getPvpDbRoom(db, code);
  if (room) await dbRoomState(db, room);
}

async function dbJoinRoom(db: PvpDatabase, session: PvpDbSession, code: string): Promise<void> {
  const room = await getPvpDbRoom(db, code);
  if (!room) return queuePvpDbMessage(db, session.client_id, { type: "error", message: `房间 ${code} 不存在` });
  if (room.host_client_id === session.client_id || room.guest_client_id === session.client_id) {
    await db.prepare(`UPDATE pvp_sessions SET room_code = ?, updated_at = ? WHERE client_id = ?`).bind(code, Date.now(), session.client_id).run();
    const refreshed = await getPvpDbSession(db, session.client_id);
    if (refreshed) await dbRestoreSession(db, refreshed);
    return;
  }
  if (room.guest_client_id) return queuePvpDbMessage(db, session.client_id, { type: "error", message: "房间已满" });
  const [joiningIdentity, hostIdentity] = await Promise.all([
    getPvpDbIdentity(db, session.client_id),
    getPvpDbIdentity(db, room.host_client_id),
  ]);
  if (!joiningIdentity || !hostIdentity) {
    return queuePvpDbMessage(db, session.client_id, { type: "error", message: "双方需要有效账号身份才能加入联机房间。" });
  }
  if (joiningIdentity === hostIdentity) {
    return queuePvpDbMessage(db, session.client_id, { type: "error", message: "同一账号不能作为自己的对手加入房间。" });
  }
  await dbLeaveQueue(db, session);
  if (!await dbLeaveRoom(db, session)) {
    await queuePvpDbMessage(db, session.client_id, { type: "error", message: "当前对局尚未安全结算，暂时不能加入新房间。" });
    return;
  }
  const now = Date.now();
  await db.prepare(`UPDATE pvp_rooms SET guest_client_id = ?, updated_at = ?
      WHERE code = ? AND guest_client_id IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM pvp_session_identities joining
          JOIN pvp_session_identities hosting
            ON hosting.client_id = pvp_rooms.host_client_id
          WHERE joining.client_id = ?
            AND joining.identity_key <> ''
            AND joining.identity_key = hosting.identity_key
        )`)
    .bind(session.client_id, now, code, session.client_id).run();
  const updated = await getPvpDbRoom(db, code);
  if (!updated || updated.guest_client_id !== session.client_id) return queuePvpDbMessage(db, session.client_id, { type: "error", message: "房间刚刚被其他玩家加入" });
  await db.prepare(`UPDATE pvp_sessions SET room_code = ?, updated_at = ? WHERE client_id = ?`).bind(code, now, session.client_id).run();
  await queuePvpDbMessage(db, session.client_id, { type: "room_joined", room: code, format: updated.format, rankedFormat: updated.ranked_format, message: "已加入房间" });
  const host = await getPvpDbSession(db, updated.host_client_id);
  await queuePvpDbMessage(db, updated.host_client_id, { type: "peer_joined", peerName: session.name, playerId: session.player_id, message: `${session.name} 已加入房间` });
  if (host) {
    await queuePvpDbMessage(db, session.client_id, {
      type: "peer_joined",
      peerName: host.name,
      playerId: host.player_id,
      message: `${host.name} 已在房间中`,
    });
  }
  if (host) await db.prepare(`UPDATE pvp_sessions SET updated_at = ? WHERE client_id = ?`).bind(now, host.client_id).run();
  await dbRoomState(db, updated);
}

async function dbJoinQueue(
  db: PvpDatabase,
  session: PvpDbSession,
  format: "ranked" | "casual",
  rankedFormat: RankedFormat,
): Promise<void> {
  await dbLeaveQueue(db, session);
  if (!await dbLeaveRoom(db, session)) {
    await queuePvpDbMessage(db, session.client_id, { type: "error", message: "当前对局尚未安全结算，暂时不能加入匹配队列。" });
    return;
  }
  const now = Date.now();
  const cutoff = now - PVP_SESSION_TTL_MS;
  const profile = await getPvpMatchProfile(db, session.client_id, format, rankedFormat);
  const playerMmr = profile.mmr;
  const playerPool = profile.pool;
  const playerIdentity = await getPvpDbIdentity(db, session.client_id);
  if (!playerIdentity) {
    return queuePvpDbMessage(db, session.client_id, { type: "error", message: "需要有效账号身份才能加入匹配队列。" });
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const candidate = await db.prepare(`SELECT q.client_id, q.player_id, q.name, q.format,
      COALESCE(q.ranked_format, 'standard') AS ranked_format,
      COALESCE(q.pool, 'standard') AS pool, COALESCE(q.rating, 1500) AS rating, q.joined_at, q.updated_at
      FROM pvp_queue q
      JOIN pvp_sessions s ON s.client_id = q.client_id
      JOIN pvp_session_identities candidate_identity
        ON candidate_identity.client_id = q.client_id AND candidate_identity.identity_key <> ''
      WHERE q.format = ? AND q.ranked_format = ? AND q.pool = ? AND q.client_id <> ? AND q.player_id <> ? AND q.updated_at >= ? AND s.room_code IS NULL
        AND candidate_identity.identity_key <> ?
        AND q.rating BETWEEN ? - ${MATCHMAKING_WINDOW_MAX} AND ? + ${MATCHMAKING_WINDOW_MAX}
        AND ABS(COALESCE(q.rating, 1500) - ?) <= MIN(${MATCHMAKING_WINDOW_MAX}, ${MATCHMAKING_WINDOW_INITIAL} + CAST(MAX(0, (? - q.joined_at) / ${MATCHMAKING_WINDOW_STEP_MS}) AS INTEGER) * ${MATCHMAKING_WINDOW_STEP})
      ORDER BY ABS(COALESCE(q.rating, 1500) - ?) ASC, q.joined_at ASC LIMIT 1`)
      .bind(format, rankedFormat, playerPool, session.client_id, session.player_id, cutoff, playerIdentity, playerMmr, playerMmr, playerMmr, now, playerMmr).first<PvpDbQueue>();
    if (!candidate) break;
    // A second tab may finish the apprentice objectives while this tab waits.
    // Refresh the candidate's server-derived profile before committing a pair
    // so a stale queue row can never bridge the protected and standard pools.
    const candidateProfile = await getPvpMatchProfile(db, candidate.client_id, format, rankedFormat);
    if (candidateProfile.pool !== candidate.pool || candidateProfile.mmr !== candidate.rating) {
      const refreshedAt = Date.now();
      const refreshed = await db.prepare(`UPDATE pvp_queue SET pool = ?, rating = ?, updated_at = ? WHERE client_id = ? AND updated_at = ?`)
        .bind(candidateProfile.pool, candidateProfile.mmr, refreshedAt, candidate.client_id, candidate.updated_at).run();
      if ((refreshed.meta?.changes ?? 0) === 1) {
        await queuePvpDbMessage(db, candidate.client_id, {
          type: "queue_joined",
          format: candidate.format,
          rankedFormat: candidate.ranked_format,
          pool: candidateProfile.pool,
          joinedAt: candidate.joined_at,
          message: candidateProfile.pool === "apprentice"
            ? "新兵保护匹配中，正在按隐藏水平寻找同轨道对手…"
            : `${candidate.format === "ranked" ? "天梯" : "休闲"}匹配中，正在按隐藏水平寻找公平对手…`,
        });
      }
      continue;
    }
    const removed = await db.prepare(`DELETE FROM pvp_queue WHERE client_id = ? AND updated_at = ?`)
      .bind(candidate.client_id, candidate.updated_at).run();
    if ((removed.meta?.changes ?? 0) !== 1) continue;
    const matchQuality: MatchQuality = matchQualityForGap(Math.abs(candidate.rating - playerMmr));
    let code = "";
    for (let codeAttempt = 0; codeAttempt < 12; codeAttempt += 1) {
      code = Array.from({ length: 4 }, () => pvpAlphabet[Math.floor(Math.random() * pvpAlphabet.length)]).join("");
      if (!(await getPvpDbRoom(db, code))) break;
    }
    await db.prepare(`INSERT INTO pvp_rooms (code, host_client_id, guest_client_id, next_sequence, format, ranked_format, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?)`)
      .bind(code, session.client_id, candidate.client_id, format, rankedFormat, now, now).run();
    await db.batch([
      db.prepare(`UPDATE pvp_sessions SET room_code = ?, updated_at = ? WHERE client_id = ?`).bind(code, now, session.client_id),
      db.prepare(`UPDATE pvp_sessions SET room_code = ?, updated_at = ? WHERE client_id = ?`).bind(code, now, candidate.client_id),
    ]);
    await queuePvpDbMessage(db, session.client_id, { type: "room_created", room: code, format, rankedFormat, pool: playerPool, matchQuality, message: "已按隐藏水平匹配到对手，房间已建立。" });
    await queuePvpDbMessage(db, candidate.client_id, { type: "room_joined", room: code, format, rankedFormat, pool: playerPool, matchQuality, message: "已按隐藏水平匹配到对手，房间已建立。" });
    await queuePvpDbMessage(db, session.client_id, { type: "peer_joined", peerName: candidate.name, playerId: candidate.player_id, message: `${candidate.name} 已加入房间` });
    await queuePvpDbMessage(db, candidate.client_id, { type: "peer_joined", peerName: session.name, playerId: session.player_id, message: `${session.name} 已加入房间` });
    const room = await getPvpDbRoom(db, code);
    if (room) await dbRoomState(db, room);
    return;
  }
  await db.prepare(`INSERT INTO pvp_queue (client_id, player_id, name, format, ranked_format, pool, rating, joined_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(client_id) DO UPDATE SET player_id = excluded.player_id, name = excluded.name, format = excluded.format, ranked_format = excluded.ranked_format, pool = excluded.pool, rating = excluded.rating, updated_at = excluded.updated_at`)
    .bind(session.client_id, session.player_id, session.name, format, rankedFormat, playerPool, playerMmr, now, now).run();
  await queuePvpDbMessage(db, session.client_id, {
    type: "queue_joined",
    format,
    rankedFormat,
    pool: playerPool,
    joinedAt: now,
    message: playerPool === "apprentice"
      ? "新兵保护匹配中，正在按隐藏水平寻找同轨道对手…"
      : `${format === "ranked" ? "天梯" : "休闲"}匹配中，正在按隐藏水平寻找公平对手…`,
  });
}

async function nextPvpSequence(db: PvpDatabase, room: PvpDbRoom): Promise<number> {
  const now = Date.now();
  const updated = await db.prepare(`UPDATE pvp_rooms
      SET next_sequence = next_sequence + 1, updated_at = ?
      WHERE code = ?
      RETURNING next_sequence`)
    .bind(now, room.code).first<{ next_sequence: number }>();
  return updated?.next_sequence ?? room.next_sequence + 1;
}

function pvpRoleIndex(room: PvpDbRoom, clientId: string): 0 | 1 | null {
  if (room.host_client_id === clientId) return 0;
  if (room.guest_client_id === clientId) return 1;
  return null;
}

type CanonicalCommandMetadata = {
  player: 0 | 1;
  commandId?: string;
  expectedVersion?: number;
};

function canonicalCommandMetadata(
  raw: Record<string, unknown>,
  role: 0 | 1,
): CanonicalCommandMetadata | null {
  const metadata: CanonicalCommandMetadata = { player: role };
  if (raw.commandId !== undefined) {
    if (
      typeof raw.commandId !== "string" ||
      raw.commandId.length < 1 ||
      raw.commandId.length > 128 ||
      /[\u0000-\u001f\u007f]/.test(raw.commandId)
    ) return null;
    // Server lifecycle commands use this namespace. Letting a client pre-seed
    // a predictable timeout/forfeit id would make engine deduplication accept
    // the later server command without advancing state.
    if (raw.commandId.startsWith("server-")) return null;
    metadata.commandId = raw.commandId;
  }
  if (raw.expectedVersion !== undefined) {
    if (
      typeof raw.expectedVersion !== "number" ||
      !Number.isSafeInteger(raw.expectedVersion) ||
      raw.expectedVersion < 0
    ) return null;
    metadata.expectedVersion = raw.expectedVersion;
  }
  return metadata;
}

function canonicalCommandString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 128
    ? value
    : null;
}

function canonicalHandIndex(value: unknown): number | undefined {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    && value < MAX_HAND_SIZE
    ? value
    : undefined;
}

function canonicalTarget(value: unknown, role: 0 | 1): BattleTarget | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.kind === "hero") {
    if (raw.player !== 0 && raw.player !== 1) return null;
    return {
      kind: "hero",
      player: role === 1 ? (raw.player === 0 ? 1 : 0) : raw.player,
    };
  }
  if (raw.kind === "unit") {
    const entityId = canonicalCommandString(raw.entityId);
    return entityId ? { kind: "unit", entityId } : null;
  }
  return null;
}

function canonicalCommand(value: unknown, role: 0 | 1): BattleCommand | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const metadata = canonicalCommandMetadata(raw, role);
  if (!metadata || typeof raw.type !== "string") return null;

  switch (raw.type) {
    case "mulligan": {
      if (
        !Array.isArray(raw.cardIndexes) ||
        raw.cardIndexes.length > 4 ||
        raw.cardIndexes.some((index) => !Number.isSafeInteger(index) || Number(index) < 0)
      ) return null;
      return { type: "mulligan", ...metadata, cardIndexes: [...raw.cardIndexes] as number[] };
    }
    case "play-card": {
      const cardId = canonicalCommandString(raw.cardId);
      if (!cardId) return null;
      const handIndex = canonicalHandIndex(raw.handIndex);
      if (raw.handIndex !== undefined && handIndex === undefined) return null;
      const placement = raw.placement === undefined
        ? undefined
        : raw.placement === "friendly" || raw.placement === "enemy"
          ? raw.placement
          : null;
      if (placement === null) return null;
      const placementFields = placement === undefined ? {} : { placement };
      if (raw.target === undefined) return { type: "play-card", ...metadata, cardId, ...(handIndex === undefined ? {} : { handIndex }), ...placementFields };
      const target = canonicalTarget(raw.target, role);
      return target ? { type: "play-card", ...metadata, cardId, ...(handIndex === undefined ? {} : { handIndex }), ...placementFields, target } : null;
    }
    case "trade-card": {
      const cardId = canonicalCommandString(raw.cardId);
      const handIndex = canonicalHandIndex(raw.handIndex);
      if (raw.handIndex !== undefined && handIndex === undefined) return null;
      return cardId ? { type: "trade-card", ...metadata, cardId, ...(handIndex === undefined ? {} : { handIndex }) } : null;
    }
    case "prepare-card": {
      const cardId = canonicalCommandString(raw.cardId);
      const handIndex = canonicalHandIndex(raw.handIndex);
      if (raw.handIndex !== undefined && handIndex === undefined) return null;
      return cardId ? { type: "prepare-card", ...metadata, cardId, ...(handIndex === undefined ? {} : { handIndex }) } : null;
    }
    case "attack": {
      const attackerId = canonicalCommandString(raw.attackerId);
      const target = canonicalTarget(raw.target, role);
      return attackerId && target ? { type: "attack", ...metadata, attackerId, target } : null;
    }
    case "hero-attack": {
      const target = canonicalTarget(raw.target, role);
      return target ? { type: "hero-attack", ...metadata, target } : null;
    }
    case "choose-discover": {
      const cardId = canonicalCommandString(raw.cardId);
      const choiceIndex = raw.choiceIndex === undefined
        ? undefined
        : typeof raw.choiceIndex === "number"
            && Number.isSafeInteger(raw.choiceIndex)
            && raw.choiceIndex >= 0
            && raw.choiceIndex < 3
          ? raw.choiceIndex
          : null;
      if (choiceIndex === null) return null;
      return cardId
        ? { type: "choose-discover", ...metadata, cardId, ...(choiceIndex === undefined ? {} : { choiceIndex }) }
        : null;
    }
    case "choose-one":
      return typeof raw.optionIndex === "number" && Number.isSafeInteger(raw.optionIndex) && raw.optionIndex >= 0
        ? { type: "choose-one", ...metadata, optionIndex: raw.optionIndex }
        : null;
    case "hero-power": {
      if (raw.target === undefined) return { type: "hero-power", ...metadata };
      const target = canonicalTarget(raw.target, role);
      return target ? { type: "hero-power", ...metadata, target } : null;
    }
    case "use-coin":
      return { type: "use-coin", ...metadata };
    case "end-turn":
      // Timeout is a server-only reason; clients cannot forge the marker.
      return { type: "end-turn", ...metadata, reason: "manual" };
    case "concede":
      return { type: "concede", ...metadata };
    default:
      return null;
  }
}

function startsPvpActionWindow(previous: MatchState, next: MatchState): boolean {
  if (previous.turn !== next.turn) return true;
  // Discover and Choose One hand control to a new, blocking decision window.
  // A card played near the end of the main-turn clock must not leave only the
  // remaining few seconds for that mandatory choice.
  if (next.phase === "discover" && previous.phase !== "discover") return true;
  if (next.phase === "choose-one" && previous.phase !== "choose-one") return true;
  return next.phase === "main" && (
    previous.phase === "mulligan" ||
    previous.phase === "discover" ||
    previous.phase === "choose-one"
  );
}

type PvpTimeoutTransition = {
  command: BattleCommand;
  state: MatchState;
};

function resolvePvpTimeout(
  state: MatchState,
  matchToken: string,
): { state: MatchState; transitions: PvpTimeoutTransition[] } {
  let next = state;
  const transitions: PvpTimeoutTransition[] = [];
  const applyTimeoutCommand = (command: BattleCommand): boolean => {
    const result = applyCommand(next, command);
    if (
      !result.accepted ||
      result.duplicate ||
      result.state === next ||
      result.state.version <= next.version
    ) return false;
    next = result.state;
    transitions.push({ command, state: next });
    return true;
  };

  if (next.phase === "mulligan") {
    for (const player of [0, 1] as const) {
      if (next.mulliganDone[player]) continue;
      if (!applyTimeoutCommand({
        type: "mulligan",
        player,
        cardIndexes: [],
        commandId: `server-timeout-${matchToken}-mulligan-${player}-${next.version}-${crypto.randomUUID()}`,
      })) break;
    }
  } else if (next.phase === "discover" && next.discover?.choices[0]) {
    applyTimeoutCommand({
      type: "choose-discover",
      player: next.discover.player,
      cardId: next.discover.choices[0],
      choiceIndex: 0,
      commandId: `server-timeout-${matchToken}-discover-${next.version}-${crypto.randomUUID()}`,
    });
  } else if (next.phase === "choose-one" && next.chooseOne?.options[0]) {
    applyTimeoutCommand({
      type: "choose-one",
      player: next.chooseOne.player,
      optionIndex: 0,
      commandId: `server-timeout-${matchToken}-choose-one-${next.version}-${crypto.randomUUID()}`,
    });
  } else if (next.phase === "main") {
    applyTimeoutCommand({
      type: "end-turn",
      player: next.activePlayer,
      reason: "timeout",
      commandId: `server-timeout-${matchToken}-turn-${next.version}-${crypto.randomUUID()}`,
    });
  }

  return { state: next, transitions };
}

async function broadcastPvpDbTransition(
  db: PvpDatabase,
  room: PvpDbRoom,
  session: PvpDbSession,
  action: string,
  command: BattleCommand,
  state: MatchState,
  matchToken: string,
): Promise<void> {
  const sequence = await nextPvpSequence(db, room);
  const recipients = [room.host_client_id, room.guest_client_id].filter(Boolean) as string[];
  await Promise.all(recipients.map(async (clientId) => {
    const viewer = pvpRoleIndex(room, clientId);
    if (viewer === null) return;
    await queuePvpDbMessage(db, clientId, {
      type: "action",
      playerId: session.player_id,
      peerName: session.name,
      sequence,
      action,
      payload: {
        command: redactPvpCommandForViewer(command, viewer),
        state: redactPvpStateForViewer(state, viewer),
        stateVersion: state.version,
        result: state.result,
        matchToken,
      },
    });
  }));
}

async function broadcastPvpDbTimeoutTransitions(
  db: PvpDatabase,
  room: PvpDbRoom,
  fallbackSession: PvpDbSession,
  action: string,
  transitions: readonly PvpTimeoutTransition[],
  matchToken: string,
): Promise<void> {
  for (const timeoutTransition of transitions) {
    const actorClientId = timeoutTransition.command.player === 0
      ? room.host_client_id
      : room.guest_client_id;
    const actor = actorClientId ? await getPvpDbSession(db, actorClientId) : null;
    await broadcastPvpDbTransition(
      db,
      room,
      actor ?? fallbackSession,
      action,
      timeoutTransition.command,
      timeoutTransition.state,
      matchToken,
    );
  }
}

async function advancePvpTimeoutOnPoll(db: PvpDatabase, session: PvpDbSession): Promise<void> {
  if (!session.room_code) return;
  const room = await getPvpDbRoom(db, session.room_code);
  if (!room || pvpRoleIndex(room, session.client_id) === null) return;
  const match = await getPvpDbMatch(db, room.code);
  const current = match ? parsePvpState(match.state_json, match.ranked_format) : null;
  const now = Date.now();
  if (
    !match ||
    !current ||
    current.phase === "game-over" ||
    now - Number(match.updated_at) < PVP_TURN_TIME_LIMIT_MS
  ) return;

  const timeout = resolvePvpTimeout(current, match.match_token);
  if (
    timeout.transitions.length === 0 ||
    timeout.state === current ||
    timeout.state.version <= current.version
  ) return;
  const updated = await db.prepare(`UPDATE pvp_matches SET state_json = ?, updated_at = ?
      WHERE room_code = ? AND match_token = ? AND state_json = ?`)
    .bind(JSON.stringify(timeout.state), now, room.code, match.match_token, match.state_json)
    .run();
  if ((updated.meta?.changes ?? 0) !== 1) return;

  await archiveFinishedPvpMatch(db, match, timeout.state, now);
  await broadcastPvpDbTimeoutTransitions(db, room, session, "command", timeout.transitions, match.match_token);
}

async function dbRelayAction(db: PvpDatabase, session: PvpDbSession, message: PvpMessage): Promise<void> {
  const room = session.room_code ? await getPvpDbRoom(db, session.room_code) : null;
  if (!room) return queuePvpDbMessage(db, session.client_id, { type: "error", message: "请先创建或加入房间" });
  const role = pvpRoleIndex(room, session.client_id);
  if (role === null) return queuePvpDbMessage(db, session.client_id, { type: "error", message: "联机会话不属于当前房间" });
  const action = typeof message.action === "string" ? message.action : "";
  if (!["ready", "match_start", "command", "rematch"].includes(action)) return queuePvpDbMessage(db, session.client_id, { type: "error", message: "联机指令类型无效" });
  const payload = message.payload && typeof message.payload === "object" && !Array.isArray(message.payload)
    ? message.payload as Record<string, unknown>
    : {};

  if (action === "ready") {
    const deckIds = parsePvpDeck(payload.deckIds, room.ranked_format);
    const requestedCardBackId = isCardBackId(payload.cardBackId) ? payload.cardBackId : null;
    const authorizedCardBackId = deckIds && requestedCardBackId
      ? await pvpAccountAuthorizesLoadout(db, session.client_id, deckIds, room.ranked_format, requestedCardBackId)
      : null;
    if (!deckIds || !authorizedCardBackId) {
      // Keep ownership, saved-deck and structural failures indistinguishable
      // so the endpoint cannot be used to probe another account's collection.
      await db.prepare(`DELETE FROM pvp_ready WHERE client_id = ?`).bind(session.client_id).run();
      return queuePvpDbMessage(db, session.client_id, { type: "action_rejected", action, message: "卡组无效，无法准备。" });
    }
    const now = Date.now();
    await db.prepare(`INSERT INTO pvp_ready (client_id, room_code, deck_json, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(client_id) DO UPDATE SET room_code = excluded.room_code, deck_json = excluded.deck_json, updated_at = excluded.updated_at`)
      .bind(session.client_id, room.code, JSON.stringify({ cardIds: deckIds, cardBackId: authorizedCardBackId }), now).run();
    const sequence = await nextPvpSequence(db, room);
    const opponentId = role === 0 ? room.guest_client_id : room.host_client_id;
    if (opponentId) await queuePvpDbMessage(db, opponentId, { type: "action", playerId: session.player_id, peerName: session.name, sequence, action, payload: { ready: true, cardBackId: authorizedCardBackId } });
    await queuePvpDbMessage(db, session.client_id, { type: "action_ack", action, sequence });
    return;
  }

  if (action === "match_start") {
    if (role !== 0) return queuePvpDbMessage(db, session.client_id, { type: "action_rejected", action, message: "只有房主可以开始对局。" });
    if (!room.guest_client_id) return queuePvpDbMessage(db, session.client_id, { type: "action_rejected", action, message: "等待对手加入房间。" });
    const existing = await getPvpDbMatch(db, room.code);
    if (existing) {
      const existingState = parsePvpState(existing.state_json, existing.ranked_format);
      return queuePvpDbMessage(db, session.client_id, {
        type: "action_rejected",
        action,
        message: existingState?.phase === "game-over"
          ? "本局已经结束，请先发起再来一局并让双方重新准备。"
          : "对局已经开始，请等待本局结束。",
      });
    }
    const hostReady = await getPvpDbReady(db, room.host_client_id);
    const guestReady = await getPvpDbReady(db, room.guest_client_id);
    let hostLoadout: { deckIds: string[]; cardBackId: string } | null = null;
    let guestLoadout: { deckIds: string[]; cardBackId: string } | null = null;
    try {
      hostLoadout = hostReady ? parsePvpReadyLoadout(JSON.parse(hostReady.deck_json), room.ranked_format) : null;
      guestLoadout = guestReady ? parsePvpReadyLoadout(JSON.parse(guestReady.deck_json), room.ranked_format) : null;
    } catch {
      hostLoadout = null;
      guestLoadout = null;
    }
    const loadoutsStillAuthorized = hostLoadout && guestLoadout && hostReady?.room_code === room.code && guestReady?.room_code === room.code
      ? await Promise.all([
          pvpAccountAuthorizesLoadout(db, room.host_client_id, hostLoadout.deckIds, room.ranked_format, hostLoadout.cardBackId),
          pvpAccountAuthorizesLoadout(db, room.guest_client_id, guestLoadout.deckIds, room.ranked_format, guestLoadout.cardBackId),
        ])
      : [null, null];
    if (!hostLoadout || !guestLoadout || !loadoutsStillAuthorized[0] || !loadoutsStillAuthorized[1]) {
      return queuePvpDbMessage(db, session.client_id, { type: "action_rejected", action, message: "双方都需要先用合法卡组准备。" });
    }
    const hostDeck = hostLoadout.deckIds;
    const guestDeck = guestLoadout.deckIds;
    const [hostIdentity, guestIdentity] = await Promise.all([
      getPvpDbIdentity(db, room.host_client_id),
      getPvpDbIdentity(db, room.guest_client_id),
    ]);
    if (!hostIdentity || !guestIdentity || hostIdentity === guestIdentity) {
      return queuePvpDbMessage(db, session.client_id, { type: "action_rejected", action, message: "双方必须使用两个不同的有效账号才能开始对局。" });
    }
    const seed = createAuthoritativePvpSeed();
    // Choose first player on the authoritative path; the room creator is not
    // always first, matching the normal Hearthstone opening cadence.
    const startingPlayer = createAuthoritativeStartingPlayer();
    const [hostCardBackProfile, guestCardBackProfile] = await Promise.all([
      loadPvpCardBackProfile(db, room.host_client_id),
      loadPvpCardBackProfile(db, room.guest_client_id),
    ]);
    const hostRewards = normalizeRankedRewardState(hostCardBackProfile.rankedRewards);
    const guestRewards = normalizeRankedRewardState(guestCardBackProfile.rankedRewards);
    const cardBackIds: [string, string] = [
      resolveCardBackSelection(hostLoadout.cardBackId, hostRewards, seed, 0, normalizeFavoriteCardBackIds(hostCardBackProfile.favoriteCardBackIds, hostRewards)),
      resolveCardBackSelection(guestLoadout.cardBackId, guestRewards, seed, 1, normalizeFavoriteCardBackIds(guestCardBackProfile.favoriteCardBackIds, guestRewards)),
    ];
    const state = {
      ...createMatch({ decks: [hostDeck, guestDeck], startingPlayer, seed, rankedFormat: room.ranked_format }),
      cardBackIds,
    } as MatchState;
    const matchToken = crypto.randomUUID();
    const now = Date.now();
    const stateJson = JSON.stringify(state);
    // D1 batches execute transactionally. The first statement is an
    // insert-if-empty CAS guarded by the exact room, ready decks and identity
    // bindings observed above; the second creates immutable ownership proof
    // only when that exact token won the race.
    await db.batch([
      db.prepare(`INSERT INTO pvp_matches (room_code, match_token, state_json, format, ranked_format, created_at, updated_at)
        SELECT r.code, ?, ?, r.format, r.ranked_format, ?, ?
        FROM pvp_rooms r
        WHERE r.code = ? AND r.host_client_id = ? AND r.guest_client_id = ? AND r.format = ? AND r.ranked_format = ?
          AND EXISTS (SELECT 1 FROM pvp_sessions WHERE client_id = r.host_client_id AND room_code = r.code)
          AND EXISTS (SELECT 1 FROM pvp_sessions WHERE client_id = r.guest_client_id AND room_code = r.code)
          AND EXISTS (SELECT 1 FROM pvp_ready WHERE client_id = ? AND room_code = ? AND deck_json = ?)
          AND EXISTS (SELECT 1 FROM pvp_ready WHERE client_id = ? AND room_code = ? AND deck_json = ?)
          AND EXISTS (SELECT 1 FROM pvp_session_identities WHERE client_id = ? AND identity_key = ? AND identity_key <> '')
          AND EXISTS (SELECT 1 FROM pvp_session_identities WHERE client_id = ? AND identity_key = ? AND identity_key <> '')
          AND ? <> ?
        ON CONFLICT(room_code) DO NOTHING`)
        .bind(
          matchToken, stateJson, now, now,
          room.code, room.host_client_id, room.guest_client_id, room.format, room.ranked_format,
          room.host_client_id, room.code, hostReady?.deck_json ?? "",
          room.guest_client_id, room.code, guestReady?.deck_json ?? "",
          room.host_client_id, hostIdentity,
          room.guest_client_id, guestIdentity,
          hostIdentity, guestIdentity,
        ),
      db.prepare(`INSERT INTO pvp_match_participants
          (match_token, room_code, host_identity, guest_identity, created_at)
        SELECT ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM pvp_matches WHERE room_code = ? AND match_token = ?)
        ON CONFLICT(match_token) DO NOTHING`)
        .bind(matchToken, room.code, hostIdentity, guestIdentity, now, room.code, matchToken),
    ]);
    const persisted = await getPvpDbMatch(db, room.code);
    if (!persisted || persisted.match_token !== matchToken) {
      return queuePvpDbMessage(db, session.client_id, {
        type: "action_rejected",
        action,
        resync: true,
        message: persisted ? "对局已经由另一条请求开始。" : "房间或准备状态刚刚改变，请重新同步。",
      });
    }
    const sequence = await nextPvpSequence(db, room);
    const startPayload = (viewer: 0 | 1) => ({
      // A neutral shell seed lets existing clients initialize before the
      // immediately following authoritative sync without revealing draw RNG.
      seed: 0,
      startingPlayer,
      format: room.format,
      rankedFormat: room.ranked_format,
      // The client only needs its own deck to open the pre-sync mulligan
      // screen. The authoritative snapshot follows through command sync.
      deck: viewer === 0 ? hostDeck : guestDeck,
      cardBackIds,
      matchToken,
    });
    await queuePvpDbMessage(db, session.client_id, {
      type: "action",
      playerId: session.player_id,
      peerName: session.name,
      sequence,
      action,
      payload: startPayload(0),
    });
    await queuePvpDbMessage(db, room.guest_client_id, {
      type: "action",
      playerId: session.player_id,
      peerName: session.name,
      sequence,
      action,
      payload: startPayload(1),
    });
    await queuePvpDbMessage(db, session.client_id, {
      type: "match_sync",
      room: room.code,
      payload: {
        state: redactPvpStateForViewer(state, 0),
        matchToken,
        format: room.format,
        rankedFormat: room.ranked_format,
        cardBackIds,
      },
    });
    await queuePvpDbMessage(db, room.guest_client_id, {
      type: "match_sync",
      room: room.code,
      payload: {
        state: redactPvpStateForViewer(state, 1),
        matchToken,
        format: room.format,
        rankedFormat: room.ranked_format,
        cardBackIds,
      },
    });
    return;
  }

  if (action === "rematch") {
    if (role !== 0) return queuePvpDbMessage(db, session.client_id, { type: "action_rejected", action, message: "只有房主可以发起再来一局。" });
    if (!room.guest_client_id) return queuePvpDbMessage(db, session.client_id, { type: "action_rejected", action, message: "等待对手加入房间。" });
    const existing = await getPvpDbMatch(db, room.code);
    const existingState = existing ? parsePvpState(existing.state_json, existing.ranked_format) : null;
    if (!existingState || existingState.phase !== "game-over") {
      return queuePvpDbMessage(db, session.client_id, { type: "action_rejected", action, message: "本局尚未结束，暂时不能重新开始。" });
    }
    const participant = await ensurePvpParticipantForExistingMatch(db, room, existing as PvpDbMatch);
    if (!pvpParticipantIsValid(participant, existing as PvpDbMatch)) {
      return queuePvpDbMessage(db, session.client_id, { type: "action_rejected", action, message: "本局身份凭证尚未完整，暂时不能覆盖对局记录。" });
    }
    const now = Date.now();
    await archiveFinishedPvpMatch(db, existing as PvpDbMatch, existingState, now);
    await db.batch([
      db.prepare(`DELETE FROM pvp_matches WHERE room_code = ?`).bind(room.code),
      db.prepare(`DELETE FROM pvp_ready WHERE room_code = ?`).bind(room.code),
    ]);
    const sequence = await nextPvpSequence(db, room);
    const resetMessage = { type: "action", playerId: session.player_id, peerName: session.name, sequence, action, payload: {} };
    await queuePvpDbMessage(db, session.client_id, resetMessage);
    await queuePvpDbMessage(db, room.guest_client_id, resetMessage);
    await db.prepare(`UPDATE pvp_rooms SET updated_at = ? WHERE code = ?`).bind(now, room.code).run();
    return;
  }

  const match = await getPvpDbMatch(db, room.code);
  const current = match ? parsePvpState(match.state_json, match.ranked_format) : null;
  const command = canonicalCommand(payload.command, role);
  if (!match || !current || !command) {
    return queuePvpDbMessage(db, session.client_id, { type: "action_rejected", action, commandId: typeof payload.command === "object" && payload.command ? (payload.command as Record<string, unknown>).commandId : undefined, message: "对局指令无效或对局尚未开始。" });
  }
  const now = Date.now();
  const timeout = command.type !== "concede" && now - Number(match.updated_at) >= PVP_TURN_TIME_LIMIT_MS
    ? resolvePvpTimeout(current, match.match_token)
    : { state: current, transitions: [] };
  const baseState = timeout.state;
  const timedOut = timeout.transitions.length > 0;

  const transition = applyCommand(baseState, command);
  if (!transition.accepted) {
    if (timedOut) {
      const timeoutStartsActionWindow = startsPvpActionWindow(current, baseState);
      const timeoutUpdateStatement = timeoutStartsActionWindow
        ? db.prepare(`UPDATE pvp_matches SET state_json = ?, updated_at = ? WHERE room_code = ? AND match_token = ? AND state_json = ?`)
          .bind(JSON.stringify(baseState), now, room.code, match.match_token, match.state_json)
        : db.prepare(`UPDATE pvp_matches SET state_json = ? WHERE room_code = ? AND match_token = ? AND state_json = ?`)
          .bind(JSON.stringify(baseState), room.code, match.match_token, match.state_json);
      const timeoutUpdated = await timeoutUpdateStatement.run();
      if ((timeoutUpdated.meta?.changes ?? 0) === 1) {
        await archiveFinishedPvpMatch(db, match, baseState, now);
        await broadcastPvpDbTimeoutTransitions(db, room, session, action, timeout.transitions, match.match_token);
      }
    }
    return queuePvpDbMessage(db, session.client_id, {
      type: "action_rejected",
      action,
      commandId: command.commandId,
      resync: true,
      message: timedOut
        ? "行动时间已耗尽，服务器已自动完成当前阶段，请等待新的行动窗口。"
        : transition.error?.message ?? "服务器拒绝了这条指令。",
    });
  }
  const startsActionWindow = startsPvpActionWindow(current, baseState) || startsPvpActionWindow(baseState, transition.state);
  const updateStatement = startsActionWindow
    ? db.prepare(`UPDATE pvp_matches SET state_json = ?, updated_at = ? WHERE room_code = ? AND match_token = ? AND state_json = ?`)
      .bind(JSON.stringify(transition.state), now, room.code, match.match_token, match.state_json)
    : db.prepare(`UPDATE pvp_matches SET state_json = ? WHERE room_code = ? AND match_token = ? AND state_json = ?`)
      .bind(JSON.stringify(transition.state), room.code, match.match_token, match.state_json);
  const updated = await updateStatement.run();
  if ((updated.meta?.changes ?? 0) !== 1) {
    return queuePvpDbMessage(db, session.client_id, {
      type: "action_rejected",
      action,
      commandId: command.commandId,
      resync: true,
      message: "对局状态刚刚更新，请等待同步后再操作。",
    });
  }
  await archiveFinishedPvpMatch(db, match, transition.state, now);
  // Send the post-transition snapshot as well as the command. Clients render
  // this authoritative state directly, so refreshes and slow polling cannot
  // leave either side one reducer step behind.
  await broadcastPvpDbTimeoutTransitions(db, room, session, action, timeout.transitions, match.match_token);
  await broadcastPvpDbTransition(db, room, session, action, command, transition.state, match.match_token);
}

async function handlePvpDbMessage(db: PvpDatabase, session: PvpDbSession, message: PvpMessage): Promise<void> {
  switch (message.type) {
    case "hello": {
      const name = typeof message.name === "string" ? message.name.trim().slice(0, 24) : session.name;
      await db.prepare(`UPDATE pvp_sessions SET name = ?, updated_at = ? WHERE client_id = ?`).bind(name || "旅者", Date.now(), session.client_id).run();
      break;
    }
    case "create_room": await dbCreateRoom(db, session, parsePvpFormat(message.format), parseRankedFormat(message.rankedFormat)); break;
    case "join_room": await dbJoinRoom(db, session, typeof message.room === "string" ? message.room.trim().toUpperCase() : ""); break;
    case "queue_join": await dbJoinQueue(db, session, parsePvpFormat(message.format), parseRankedFormat(message.rankedFormat)); break;
    case "queue_leave": await dbLeaveQueue(db, session); await queuePvpDbMessage(db, session.client_id, { type: "queue_left", message: "已取消匹配。" }); break;
    case "action": await dbRelayAction(db, session, message); break;
    case "sync":
      await advancePvpTimeoutOnPoll(db, session);
      await dbRestoreSession(db, session);
      break;
    case "leave_room": await dbLeaveRoom(db, session); break;
    default: break;
  }
}

function pvpJson(peer: PvpPeer, message: PvpMessage): void {
  try {
    if (peer.socket) {
      peer.socket.send(JSON.stringify(message));
      return;
    }
    peer.queue?.push(message);
    if (peer.queue && peer.queue.length > 100) peer.queue.splice(0, peer.queue.length - 100);
  } catch {
    leavePvpPeer(peer);
  }
}

function pvpError(peer: PvpPeer, message: string): void {
  pvpJson(peer, { type: "error", message });
}

function pvpRoomState(room: PvpRoom): void {
  const players = room.peers.map((peer) => ({ id: peer.id, name: peer.name }));
  room.peers.forEach((peer) => pvpJson(peer, {
    type: "room_state",
    room: room.code,
    format: room.format,
    rankedFormat: room.rankedFormat,
    payload: { players, format: room.format, rankedFormat: room.rankedFormat },
  }));
}

function removeMemoryQueue(peer: PvpPeer): void {
    for (const [queueKey, peers] of pvpQueues) {
      const remaining = peers.filter((candidate) => candidate !== peer);
    if (remaining.length) pvpQueues.set(queueKey, remaining);
    else pvpQueues.delete(queueKey);
  }
}

function leavePvpRoom(peer: PvpPeer): void {
  removeMemoryQueue(peer);
  const code = peer.room;
  if (!code) return;
  const room = pvpRooms.get(code);
  const leavingRole = room ? memoryPvpRoleIndex(room, peer) : null;
  peer.room = null;
  if (
    room?.matchState &&
    room.matchState.phase !== "game-over" &&
    leavingRole !== null
  ) {
    const command: BattleCommand = {
      type: "concede",
      player: leavingRole,
      commandId: `server-forfeit-${room.matchToken ?? "memory"}-${room.matchState.version}-${crypto.randomUUID()}`,
    };
    const transition = applyCommand(room.matchState, command);
    if (
      transition.accepted &&
      !transition.duplicate &&
      transition.state !== room.matchState &&
      transition.state.version > room.matchState.version &&
      transition.state.phase === "game-over"
    ) {
      room.matchState = transition.state;
      broadcastMemoryPvpTransition(room, peer, "command", command, transition.state);
    }
  }
  if (!room) return;
  const promotesNextPeer = room.peers[0] === peer;
  room.peers = room.peers.filter((candidate) => candidate !== peer);
  room.peers.forEach((other) => pvpJson(other, {
    type: "peer_left",
    peerName: peer.name,
    message: `${peer.name} 已离开房间`,
  }));
  if (room.peers.length === 0) {
    pvpRooms.delete(code);
  } else {
    // A memory room is authoritative while it exists. Once one player leaves,
    // discard the private match and both ready decks so a replacement player
    // cannot inherit a stale state or an opponent's hidden cards.
    room.readyDecks.clear();
    room.readyCardBacks.clear();
    room.matchState = undefined;
    room.matchToken = undefined;
    room.matchUpdatedAt = undefined;
    if (promotesNextPeer && room.peers[0]) {
      pvpJson(room.peers[0], {
        type: "room_created",
        room: room.code,
        format: room.format,
        rankedFormat: room.rankedFormat,
        message: "原房主已离开，你现在是房主。",
      });
    }
    pvpRoomState(room);
  }
}

function queuePvpPeer(peer: PvpPeer, format: "ranked" | "casual", rankedFormat: RankedFormat): void {
  removeMemoryQueue(peer);
  leavePvpRoom(peer);
  const queueKey = `${format}:${rankedFormat}`;
  const waiting = pvpQueues.get(queueKey) ?? [];
  const opponentIndex = waiting.findIndex((candidate) => (
    candidate !== peer &&
    (!peer.identityKey || !candidate.identityKey || candidate.identityKey !== peer.identityKey)
  ));
  const opponent = opponentIndex >= 0 ? waiting.splice(opponentIndex, 1)[0] : undefined;
  if (opponent && opponent !== peer) {
    if (waiting.length) pvpQueues.set(queueKey, waiting); else pvpQueues.delete(queueKey);
    const room: PvpRoom = {
      code: "",
      format,
      rankedFormat,
      peers: [opponent, peer],
      nextSequence: 0,
      readyDecks: new Map(),
      readyCardBacks: new Map(),
    };
    let code = "";
    do {
      code = Array.from({ length: 4 }, () => pvpAlphabet[Math.floor(Math.random() * pvpAlphabet.length)]).join("");
    } while (pvpRooms.has(code));
    room.code = code;
    pvpRooms.set(code, room);
    opponent.room = code;
    peer.room = code;
    pvpJson(opponent, { type: "room_created", room: code, format, rankedFormat, message: "已匹配到对手，房间已建立。" });
    pvpJson(peer, { type: "room_joined", room: code, format, rankedFormat, message: "已匹配到对手，房间已建立。" });
    pvpJson(opponent, { type: "peer_joined", peerName: peer.name, playerId: peer.id, message: `${peer.name} 已加入房间` });
    pvpJson(peer, { type: "peer_joined", peerName: opponent.name, playerId: opponent.id, message: `${opponent.name} 已加入房间` });
    pvpRoomState(room);
    return;
  }
  const next = waiting.filter((candidate) => candidate.id !== peer.id);
  next.push(peer);
  pvpQueues.set(queueKey, next);
  pvpJson(peer, { type: "queue_joined", format, rankedFormat, joinedAt: Date.now(), message: `${rankedFormat === "standard" ? "标准" : "狂野"}${format === "ranked" ? "天梯" : "休闲"}匹配中，正在寻找同模式对手…` });
}

function leavePvpPeer(peer: PvpPeer): void {
  if (peer.socket) pvpPeers.delete(peer.socket);
  if (pvpPollSessions.get(peer.clientId) === peer) pvpPollSessions.delete(peer.clientId);
  leavePvpRoom(peer);
}

function createPvpRoom(peer: PvpPeer, format: "ranked" | "casual", rankedFormat: RankedFormat): void {
  leavePvpRoom(peer);
  let code = "";
  do {
    code = Array.from({ length: 4 }, () => pvpAlphabet[Math.floor(Math.random() * pvpAlphabet.length)]).join("");
  } while (pvpRooms.has(code));
  const room: PvpRoom = {
    code,
    format,
    rankedFormat,
    peers: [peer],
    nextSequence: 0,
    readyDecks: new Map(),
    readyCardBacks: new Map(),
  };
  pvpRooms.set(code, room);
  peer.room = code;
  pvpJson(peer, { type: "room_created", room: code, format, rankedFormat, message: "房间已创建，等待对手加入" });
  pvpRoomState(room);
}

function joinPvpRoom(peer: PvpPeer, code: string): void {
  const room = pvpRooms.get(code);
  if (!room) return pvpError(peer, `房间 ${code} 不存在`);
  if (room.peers.length >= 2) return pvpError(peer, "房间已满");
  if (peer.identityKey && room.peers[0]?.identityKey === peer.identityKey) {
    return pvpError(peer, "同一账号不能作为自己的对手加入房间。");
  }
  leavePvpRoom(peer);
  room.peers.push(peer);
  peer.room = room.code;
  pvpJson(peer, { type: "room_joined", room: room.code, format: room.format, rankedFormat: room.rankedFormat, message: "已加入房间" });
  const recipients = room.peers.filter((other) => other !== peer);
  recipients.forEach((other) => pvpJson(other, {
    type: "peer_joined",
    peerName: peer.name,
    playerId: peer.id,
    message: `${peer.name} 已加入房间`,
  }));
  const host = room.peers[0];
  if (host && host !== peer) {
    pvpJson(peer, {
      type: "peer_joined",
      peerName: host.name,
      playerId: host.id,
      message: `${host.name} 已在房间中`,
    });
  }
  pvpRoomState(room);
}

function memoryPvpRoleIndex(room: PvpRoom, peer: PvpPeer): 0 | 1 | null {
  const index = room.peers.indexOf(peer);
  return index === 0 ? 0 : index === 1 ? 1 : null;
}

function broadcastMemoryPvpTransition(
  room: PvpRoom,
  sender: PvpPeer,
  action: string,
  command: BattleCommand,
  state: MatchState,
): void {
  const sequence = ++room.nextSequence;
  room.peers.forEach((recipient) => {
    const viewer = memoryPvpRoleIndex(room, recipient);
    if (viewer === null) return;
    pvpJson(recipient, {
      type: "action",
      playerId: sender.id,
      peerName: sender.name,
      sequence,
      action,
      payload: {
        command: redactPvpCommandForViewer(command, viewer),
        state: redactPvpStateForViewer(state, viewer),
        stateVersion: state.version,
        result: state.result,
        ...(room.matchToken ? { matchToken: room.matchToken } : {}),
      },
    });
  });
  pvpJson(sender, { type: "action_ack", action, sequence });
}

function advanceMemoryPvpTimeoutOnPoll(peer: PvpPeer): void {
  const room = peer.room ? pvpRooms.get(peer.room) : null;
  const current = room?.matchState;
  const now = Date.now();
  if (
    !room ||
    !current ||
    current.phase === "game-over" ||
    now - (room.matchUpdatedAt ?? now) < PVP_TURN_TIME_LIMIT_MS
  ) return;
  const timeout = resolvePvpTimeout(current, room.matchToken ?? "memory");
  if (
    timeout.transitions.length === 0 ||
    timeout.state === current ||
    timeout.state.version <= current.version
  ) return;
  room.matchState = timeout.state;
  room.matchUpdatedAt = now;
  for (const timeoutTransition of timeout.transitions) {
    const actor = room.peers[timeoutTransition.command.player] ?? peer;
    broadcastMemoryPvpTransition(room, actor, "command", timeoutTransition.command, timeoutTransition.state);
  }
}

function rejectMemoryPvpAction(peer: PvpPeer, action: string, message: string, extras: PvpMessage = {}): void {
  pvpJson(peer, { type: "action_rejected", action, message, ...extras });
}

function relayPvpAction(peer: PvpPeer, message: PvpMessage): void {
  const room = peer.room ? pvpRooms.get(peer.room) : null;
  if (!room) return pvpError(peer, "请先创建或加入房间");
  const role = memoryPvpRoleIndex(room, peer);
  if (role === null) return pvpError(peer, "联机会话不属于当前房间");
  const action = typeof message.action === "string" ? message.action : "";
  if (!["ready", "match_start", "command", "rematch"].includes(action)) {
    return pvpError(peer, "联机指令类型无效");
  }
  const rawPayload = message.payload && typeof message.payload === "object" && !Array.isArray(message.payload)
    ? message.payload as Record<string, unknown>
    : {};

  if (action === "ready") {
    // The in-memory transport is a local/dev fallback with no authenticated
    // account-state database. It can enforce game deck rules only; production
    // D1 additionally verifies saved-deck membership and collection ownership.
    const deckIds = parsePvpDeck(rawPayload.deckIds, room.rankedFormat);
    const cardBackId = isCardBackId(rawPayload.cardBackId) ? rawPayload.cardBackId : null;
    if (!deckIds || !cardBackId) return rejectMemoryPvpAction(peer, action, "卡组或卡背无效，无法准备。");
    room.readyDecks.set(peer.clientId, deckIds);
    room.readyCardBacks.set(peer.clientId, cardBackId);
    const sequence = ++room.nextSequence;
    room.peers.filter((other) => other !== peer).forEach((other) => pvpJson(other, {
      type: "action",
      playerId: peer.id,
      peerName: peer.name,
      sequence,
      action,
      payload: { ready: true, cardBackId },
    }));
    pvpJson(peer, { type: "action_ack", action, sequence });
    return;
  }

  if (action === "match_start") {
    if (role !== 0) return rejectMemoryPvpAction(peer, action, "只有房主可以开始对局。");
    if (room.peers.length < 2) return rejectMemoryPvpAction(peer, action, "等待对手加入房间。");
    const hostDeck = room.readyDecks.get(room.peers[0].clientId);
    const guestDeck = room.readyDecks.get(room.peers[1].clientId);
    const hostCardBack = room.readyCardBacks.get(room.peers[0].clientId);
    const guestCardBack = room.readyCardBacks.get(room.peers[1].clientId);
    if (!hostDeck || !guestDeck || !hostCardBack || !guestCardBack) return rejectMemoryPvpAction(peer, action, "双方都需要先用合法卡组与卡背准备。");
    if (room.matchState) {
      return rejectMemoryPvpAction(
        peer,
        action,
        room.matchState.phase === "game-over"
          ? "本局已经结束，请先发起再来一局并让双方重新准备。"
          : "对局已经开始，请等待本局结束。",
      );
    }
    const seed = createAuthoritativePvpSeed();
    const startingPlayer = createAuthoritativeStartingPlayer();
    const cardBackIds: [string, string] = [
      hostCardBack.startsWith("random-") ? DEFAULT_CARD_BACK_ID : hostCardBack,
      guestCardBack.startsWith("random-") ? DEFAULT_CARD_BACK_ID : guestCardBack,
    ];
    room.matchState = {
      ...createMatch({ decks: [hostDeck, guestDeck], startingPlayer, seed, rankedFormat: room.rankedFormat }),
      cardBackIds,
    } as MatchState;
    room.matchToken = crypto.randomUUID();
    room.matchUpdatedAt = Date.now();
    const sequence = ++room.nextSequence;
    room.peers.forEach((other, index) => {
      pvpJson(other, {
        type: "action",
        playerId: peer.id,
        peerName: peer.name,
        sequence,
        action,
        payload: {
          seed: 0,
          startingPlayer,
          format: room.format,
          rankedFormat: room.rankedFormat,
          deck: index === 0 ? hostDeck : guestDeck,
          cardBackIds,
          matchToken: room.matchToken,
        },
      });
      const viewer = index === 0 ? 0 : 1;
      pvpJson(other, {
        type: "match_sync",
        room: room.code,
        payload: {
          state: redactPvpStateForViewer(room.matchState as MatchState, viewer),
          matchToken: room.matchToken,
          format: room.format,
          rankedFormat: room.rankedFormat,
          cardBackIds,
        },
      });
    });
    pvpJson(peer, { type: "action_ack", action, sequence });
    return;
  }

  if (action === "rematch") {
    if (role !== 0) return rejectMemoryPvpAction(peer, action, "只有房主可以发起再来一局");
    if (!room.peers[1]) return rejectMemoryPvpAction(peer, action, "等待对手加入房间。");
    if (room.matchState?.phase !== "game-over") return rejectMemoryPvpAction(peer, action, "本局尚未结束，暂时不能重新开始。");
    room.readyDecks.clear();
    room.readyCardBacks.clear();
    room.matchState = undefined;
    room.matchToken = undefined;
    room.matchUpdatedAt = undefined;
    const sequence = ++room.nextSequence;
    room.peers.forEach((other) => pvpJson(other, {
      type: "action",
      playerId: peer.id,
      peerName: peer.name,
      sequence,
      action,
      payload: {},
    }));
    pvpJson(peer, { type: "action_ack", action, sequence });
    return;
  }

  const current = room.matchState;
  const command = canonicalCommand(rawPayload.command, role);
  if (!current || !command) {
    return pvpJson(peer, {
      type: "action_rejected",
      action,
      commandId: typeof rawPayload.command === "object" && rawPayload.command ? (rawPayload.command as Record<string, unknown>).commandId : undefined,
      message: "对局指令无效或对局尚未开始。",
    });
  }
  const now = Date.now();
  const timeout = command.type !== "concede" && now - (room.matchUpdatedAt ?? now) >= PVP_TURN_TIME_LIMIT_MS
    ? resolvePvpTimeout(current, room.matchToken ?? "memory")
    : { state: current, transitions: [] };
  const baseState = timeout.state;
  const timedOut = timeout.transitions.length > 0;
  const transition = applyCommand(baseState, command);
  if (!transition.accepted) {
    if (timedOut) {
      room.matchState = baseState;
      if (startsPvpActionWindow(current, baseState)) {
        room.matchUpdatedAt = now;
      }
      for (const timeoutTransition of timeout.transitions) {
        const timeoutActor = room.peers[timeoutTransition.command.player] ?? peer;
        broadcastMemoryPvpTransition(room, timeoutActor, action, timeoutTransition.command, timeoutTransition.state);
      }
    }
    return pvpJson(peer, {
      type: "action_rejected",
      action,
      commandId: command.commandId,
      resync: true,
      message: timedOut ? "行动时间已耗尽，服务器已自动完成当前阶段，请等待新的行动窗口。" : transition.error?.message ?? "服务器拒绝了这条指令。",
    });
  }
  room.matchState = transition.state;
  if (startsPvpActionWindow(current, baseState) || startsPvpActionWindow(baseState, transition.state)) {
    room.matchUpdatedAt = now;
  }
  for (const timeoutTransition of timeout.transitions) {
    const timeoutActor = room.peers[timeoutTransition.command.player] ?? peer;
    broadcastMemoryPvpTransition(room, timeoutActor, action, timeoutTransition.command, timeoutTransition.state);
  }
  broadcastMemoryPvpTransition(room, peer, action, command, transition.state);
}

function handlePvpMessage(peer: PvpPeer, raw: unknown): void {
  if (typeof raw !== "string") return;
  let message: PvpMessage;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    message = parsed as PvpMessage;
  } catch {
    return pvpError(peer, "联机消息格式无效");
  }
  switch (message.type) {
    case "hello": {
      const name = typeof message.name === "string" ? message.name.trim().slice(0, 24) : "";
      if (name) peer.name = name;
      break;
    }
    case "create_room":
      createPvpRoom(peer, parsePvpFormat(message.format), parseRankedFormat(message.rankedFormat));
      break;
    case "join_room":
      joinPvpRoom(peer, typeof message.room === "string" ? message.room.trim().toUpperCase() : "");
      break;
    case "queue_join":
      queuePvpPeer(peer, parsePvpFormat(message.format), parseRankedFormat(message.rankedFormat));
      break;
    case "queue_leave":
      removeMemoryQueue(peer);
      pvpJson(peer, { type: "queue_left", message: "已取消匹配。" });
      break;
    case "action":
      relayPvpAction(peer, message);
      break;
    case "sync": {
      advanceMemoryPvpTimeoutOnPoll(peer);
      const room = peer.room ? pvpRooms.get(peer.room) : null;
      if (room) {
        pvpRoomState(room);
        const viewer = memoryPvpRoleIndex(room, peer);
        if (viewer !== null && room.matchState && room.matchToken) {
          pvpJson(peer, {
            type: "match_sync",
            room: room.code,
            payload: {
              state: redactPvpStateForViewer(room.matchState, viewer),
              matchToken: room.matchToken,
              format: room.format,
              rankedFormat: room.rankedFormat,
            },
          });
        }
      }
      break;
    }
    case "leave_room":
      leavePvpRoom(peer);
      break;
    default:
      break;
  }
}

function handlePvpUpgrade(request: Request): Response {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("ASTRA PVP WebSocket endpoint", { status: 426 });
  }
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  const peer: PvpPeer = {
    socket: server,
    clientId: `ws-${crypto.randomUUID()}`,
    identityKey: pvpRequestIdentity(request),
    id: `p-${crypto.randomUUID()}`,
    name: "旅者",
    room: null,
  };
  pvpPeers.set(server, peer);
  (server as unknown as { accept: () => void }).accept();
  server.addEventListener("message", (event) => handlePvpMessage(peer, event.data));
  server.addEventListener("close", () => leavePvpPeer(peer));
  server.addEventListener("error", () => leavePvpPeer(peer));
  pvpJson(peer, { type: "welcome", playerId: peer.id, message: "连接成功" });
  return new Response(null, { status: 101, webSocket: client });
}

function pvpJsonResponse(payload: PvpMessage, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function pvpRequestIdentity(request: Request): string {
  const userId = request.headers.get("oai-authenticated-user-id")?.trim();
  if (userId) return `oai-id:${userId}`;
  const email = request.headers.get("oai-authenticated-user-email")?.trim().toLowerCase();
  if (email) return `oai-email:${email}`;
  const cookie = request.headers.get("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== "ember-device-id") continue;
    const value = part.slice(separator + 1).trim();
    if (value) return `device:${value}`;
  }
  return "";
}

async function pvpRequestOwnsSession(
  db: PvpDatabase,
  request: Request,
  clientId: string,
): Promise<boolean> {
  const boundIdentity = await getPvpDbIdentity(db, clientId);
  // Older/local sessions without an account binding retain the random
  // clientId as their bearer credential. Once an identity is bound, every
  // poll and mutation must present that same platform identity or device
  // cookie; possession of a leaked query-string id is no longer sufficient.
  return !boundIdentity || pvpRequestIdentity(request) === boundIdentity;
}

async function handlePvpPollMemory(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET") {
    const clientId = url.searchParams.get("clientId") ?? "";
    const peer = pvpPollSessions.get(clientId);
    if (!peer) return pvpJsonResponse({ ok: false, message: "联机会话已过期，请重新连接。" }, 404);
    advanceMemoryPvpTimeoutOnPoll(peer);
    const cursor = Math.max(0, Number(url.searchParams.get("cursor") ?? 0) || 0);
    const messages = peer.queue ?? [];
    return pvpJsonResponse({ ok: true, cursor: messages.length, messages: messages.slice(cursor) });
  }
  if (request.method === "DELETE") {
    const clientId = url.searchParams.get("clientId") ?? "";
    const peer = pvpPollSessions.get(clientId);
    if (peer) leavePvpPeer(peer);
    return pvpJsonResponse({ ok: true });
  }
  if (request.method !== "POST") return pvpJsonResponse({ ok: false, message: "仅支持 GET、POST、DELETE。" }, 405);

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid body");
    body = parsed as Record<string, unknown>;
  } catch {
    return pvpJsonResponse({ ok: false, message: "联机消息格式无效。" }, 400);
  }

  if (body.type === "connect") {
    const clientId = `poll-${crypto.randomUUID()}`;
    const peer: PvpPeer = {
      clientId,
      identityKey: pvpRequestIdentity(request),
      id: `p-${crypto.randomUUID()}`,
      name: typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 24) : "旅者",
      room: null,
      queue: [],
    };
    pvpPollSessions.set(clientId, peer);
    pvpJson(peer, { type: "welcome", playerId: peer.id, message: "连接成功" });
    return pvpJsonResponse({ ok: true, clientId, cursor: 0, messages: peer.queue ?? [] });
  }

  const clientId = typeof body.clientId === "string" ? body.clientId : "";
  const peer = pvpPollSessions.get(clientId);
  if (!peer) return pvpJsonResponse({ ok: false, message: "联机会话已过期，请重新连接。" }, 404);
  if (body.type === "message" && body.message && typeof body.message === "object") {
    handlePvpMessage(peer, JSON.stringify(body.message));
  }
  return pvpJsonResponse({ ok: true });
}

async function handlePvpPoll(request: Request, env: Env): Promise<Response> {
  const db = getPvpDatabase(env);
  if (!db) return handlePvpPollMemory(request);
  try {
    await ensurePvpSchema(db);
    const url = new URL(request.url);
    if (request.method === "GET") {
      const clientId = url.searchParams.get("clientId") ?? "";
      const session = await getPvpDbSession(db, clientId);
      if (!session) return pvpJsonResponse({ ok: false, message: "联机会话已过期，请重新连接。" }, 404);
      if (!await pvpRequestOwnsSession(db, request, clientId)) {
        return pvpJsonResponse({ ok: false, message: "联机会话身份不匹配。" }, 403);
      }
      await db.prepare(`UPDATE pvp_sessions SET updated_at = ? WHERE client_id = ?`).bind(Date.now(), clientId).run();
      await advancePvpTimeoutOnPoll(db, session);
      const cursor = Math.max(0, Number(url.searchParams.get("cursor") ?? 0) || 0);
      const result = await db.prepare(`SELECT message_id, payload_json FROM pvp_messages WHERE client_id = ? AND message_id > ? ORDER BY message_id ASC LIMIT 100`)
        .bind(clientId, cursor).all<{ message_id: number; payload_json: string }>();
      const rows = result.results ?? [];
      const messages = rows.map((row) => parsePvpPayload(row.payload_json)).filter((message): message is PvpMessage => Boolean(message));
      const nextCursor = rows.length ? Math.max(cursor, ...rows.map((row) => Number(row.message_id) || cursor)) : cursor;
      return pvpJsonResponse({ ok: true, cursor: nextCursor, messages });
    }
    if (request.method === "DELETE") {
      const clientId = url.searchParams.get("clientId") ?? "";
      const session = await getPvpDbSession(db, clientId);
      if (session && !await pvpRequestOwnsSession(db, request, clientId)) {
        return pvpJsonResponse({ ok: false, message: "联机会话身份不匹配。" }, 403);
      }
      if (session) {
        await dbLeaveQueue(db, session);
        if (!await dbLeaveRoom(db, session)) {
          return pvpJsonResponse({ ok: false, message: "当前对局尚未安全结算，请稍后重试断开连接。" }, 409);
        }
      }
      await db.prepare(`DELETE FROM pvp_messages WHERE client_id = ?`).bind(clientId).run();
      await db.prepare(`DELETE FROM pvp_session_identities WHERE client_id = ?`).bind(clientId).run();
      await db.prepare(`DELETE FROM pvp_sessions WHERE client_id = ?`).bind(clientId).run();
      return pvpJsonResponse({ ok: true });
    }
    if (request.method !== "POST") return pvpJsonResponse({ ok: false, message: "仅支持 GET、POST、DELETE。" }, 405);
    const declaredLength = Number(request.headers.get("content-length") ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > PVP_MAX_BODY_BYTES) {
      return pvpJsonResponse({ ok: false, message: "联机消息过大。" }, 413);
    }
    let body: Record<string, unknown>;
    try {
      const rawBody = await request.text();
      if (new TextEncoder().encode(rawBody).byteLength > PVP_MAX_BODY_BYTES) {
        return pvpJsonResponse({ ok: false, message: "联机消息过大。" }, 413);
      }
      const parsed = JSON.parse(rawBody);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid body");
      body = parsed as Record<string, unknown>;
    } catch {
      return pvpJsonResponse({ ok: false, message: "联机消息格式无效。" }, 400);
    }
    if (body.type === "connect") {
      await prunePvpDb(db);
      const now = Date.now();
      const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 24) : "旅者";
      const identityKey = pvpRequestIdentity(request);
      let requestedClientId = typeof body.clientId === "string" && /^[A-Za-z0-9_-]{8,96}$/.test(body.clientId)
        ? body.clientId
        : "";
      // A browser refresh should reattach to its short-lived session instead of
      // creating a second player and orphaning the room. Expired sessions are
      // discarded so a stale tab cannot reclaim a room indefinitely.
      if (requestedClientId) {
        const existing = await getPvpDbSession(db, requestedClientId);
        const existingIdentity = existing ? await getPvpDbIdentity(db, requestedClientId) : "";
        if (existing && existingIdentity && identityKey !== existingIdentity) {
          // A copied sessionStorage id must not let another account take over
          // the original player's room.
          requestedClientId = "";
        }
      }
      if (requestedClientId) {
        const existing = await getPvpDbSession(db, requestedClientId);
        if (existing && now - Number(existing.updated_at || 0) <= PVP_SESSION_TTL_MS) {
          await db.prepare(`UPDATE pvp_sessions SET name = ?, updated_at = ? WHERE client_id = ?`)
            .bind(name, now, requestedClientId).run();
          if (identityKey) {
            await db.prepare(`INSERT INTO pvp_session_identities (client_id, identity_key) VALUES (?, ?)
              ON CONFLICT(client_id) DO UPDATE SET identity_key = CASE
                WHEN pvp_session_identities.identity_key = '' THEN excluded.identity_key
                ELSE pvp_session_identities.identity_key END`)
              .bind(requestedClientId, identityKey).run();
          }
          const refreshed = await getPvpDbSession(db, requestedClientId);
          if (refreshed) {
            await dbRestoreSession(db, refreshed);
            const result = await db.prepare(`SELECT message_id, payload_json FROM pvp_messages WHERE client_id = ? ORDER BY message_id ASC`)
              .bind(requestedClientId).all<{ message_id: number; payload_json: string }>();
            const rows = result.results ?? [];
            return pvpJsonResponse({
              ok: true,
              clientId: requestedClientId,
              cursor: rows.length ? Math.max(...rows.map((row) => Number(row.message_id) || 0)) : 0,
              messages: rows.map((row) => parsePvpPayload(row.payload_json)).filter((message): message is PvpMessage => Boolean(message)),
            });
          }
        }
        if (existing) {
          // Expiry is a real departure. Resolve an unfinished ranked game as a
          // server-side forfeit while the immutable identity binding still
          // exists, then remove the transport session.
          await dbLeaveQueue(db, existing);
          if (!await dbLeaveRoom(db, existing)) {
            return pvpJsonResponse({ ok: false, message: "过期会话的对局结果尚未安全固化，请稍后重试。" }, 409);
          }
          await db.prepare(`DELETE FROM pvp_messages WHERE client_id = ?`).bind(requestedClientId).run();
          await db.prepare(`DELETE FROM pvp_session_identities WHERE client_id = ?`).bind(requestedClientId).run();
          await db.prepare(`DELETE FROM pvp_sessions WHERE client_id = ?`).bind(requestedClientId).run();
        }
      }
      const clientId = requestedClientId || `poll-${crypto.randomUUID()}`;
      const playerId = `p-${crypto.randomUUID()}`;
      await db.batch([
        db.prepare(`INSERT INTO pvp_sessions (client_id, player_id, name, room_code, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)`)
          .bind(clientId, playerId, name, now, now),
        db.prepare(`INSERT INTO pvp_session_identities (client_id, identity_key) VALUES (?, ?)`)
          .bind(clientId, identityKey),
      ]);
      await queuePvpDbMessage(db, clientId, { type: "welcome", playerId, message: "连接成功" });
      const result = await db.prepare(`SELECT message_id, payload_json FROM pvp_messages WHERE client_id = ? ORDER BY message_id ASC`).bind(clientId).all<{ message_id: number; payload_json: string }>();
      const rows = result.results ?? [];
      return pvpJsonResponse({ ok: true, clientId, cursor: rows.length ? Math.max(...rows.map((row) => Number(row.message_id) || 0)) : 0, messages: rows.map((row) => parsePvpPayload(row.payload_json)).filter((message): message is PvpMessage => Boolean(message)) });
    }
    const clientId = typeof body.clientId === "string" ? body.clientId : "";
    const session = await getPvpDbSession(db, clientId);
    if (!session) return pvpJsonResponse({ ok: false, message: "联机会话已过期，请重新连接。" }, 404);
    if (!await pvpRequestOwnsSession(db, request, clientId)) {
      return pvpJsonResponse({ ok: false, message: "联机会话身份不匹配。" }, 403);
    }
    await db.prepare(`UPDATE pvp_sessions SET updated_at = ? WHERE client_id = ?`).bind(Date.now(), clientId).run();
    if (body.type === "message" && body.message && typeof body.message === "object" && !Array.isArray(body.message)) {
      await handlePvpDbMessage(db, session, body.message as PvpMessage);
    }
    return pvpJsonResponse({ ok: true });
  } catch {
    return pvpJsonResponse({ ok: false, message: "联机大厅暂时不可用，请稍后重试。" }, 503);
  }
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    if (url.pathname === "/api/pvp") return handlePvpUpgrade(request);
    if (url.pathname === "/api/pvp-poll") return handlePvpPoll(request, env);

    return handler.fetch(request, env, ctx);
  },
};

export default worker;
