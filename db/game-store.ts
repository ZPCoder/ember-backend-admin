import { env } from "cloudflare:workers";
import {
  CARD_CATALOG,
  DEFAULT_STARTER_DECK,
  validateDeck,
} from "../lib/game";

export type MatchResult = "win" | "loss";
export type MatchMode = "ai" | "pvp";

export type GameIdentity = {
  email: string;
  displayName: string;
  isDemo: boolean;
};

export type PlayerDeck = {
  id: string;
  name: string;
  cardIds: string[];
  updatedAt: string;
};

export type PlayerTask = {
  id: string;
  title: string;
  description: string;
  progress: number;
  target: number;
  rewardGold: number;
  claimed: boolean;
};

export type MatchRecord = {
  id: string;
  result: MatchResult;
  mode: MatchMode;
  opponent: string;
  rewardGold: number;
  createdAt: string;
};

export type PlayerState = {
  id: string;
  email: string;
  displayName: string;
  currencies: {
    gold: number;
    dust: number;
  };
  packsAvailable: number;
  collection: Record<string, number>;
  decks: PlayerDeck[];
  activeDeckId: string;
  tasks: PlayerTask[];
  recentMatches: MatchRecord[];
  stats: {
    wins: number;
    losses: number;
    matchesPlayed: number;
  };
  updatedAt: string;
};

export type SaveDeckResult = {
  player: PlayerState;
  savedDeck: PlayerDeck;
  replayed: boolean;
};

export type ClaimTaskResult = {
  player: PlayerState;
  claimedTaskId: string;
  rewardGold: number;
  replayed: boolean;
};

export type OpenPackResult = {
  player: PlayerState;
  openedCards: Array<{ cardId: string; count: number }>;
  replayed: boolean;
};

export type RecordMatchResult = {
  player: PlayerState;
  match: MatchRecord;
  replayed: boolean;
};

type StoredPlayerState = Omit<
  PlayerState,
  "id" | "email" | "displayName" | "recentMatches" | "updatedAt"
>;

type PlayerRow = {
  id: string;
  email: string;
  displayName: string;
};

type StateRow = {
  stateJson: string;
  version: number;
  updatedAt: string;
};

type MatchRow = {
  id: string;
  result: MatchResult;
  mode: MatchMode;
  opponent: string;
  rewardGold: number;
  createdAt: string;
};

type AuditRow = {
  action: string;
  resultJson: string;
};

type D1RunResultLike = {
  success: boolean;
  meta?: {
    changes?: number;
  };
};

type D1AllResultLike<T> = {
  results: T[];
};

interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1AllResultLike<T>>;
  run(): Promise<D1RunResultLike>;
}

interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
  batch(
    statements: D1PreparedStatementLike[],
  ): Promise<D1RunResultLike[]>;
}

type MutationOutput<T> = {
  nextState: StoredPlayerState;
  result: T;
  match?: MatchRecord;
};

const STARTING_GOLD = 260;
const STARTING_PACKS = 3;
const WIN_REWARD_GOLD = 60;
const LOSS_REWARD_GOLD = 20;
const MAX_MUTATION_ATTEMPTS = 4;

let schemaReady: Promise<void> | null = null;

export class GameStoreError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "GameStoreError";
  }
}

export async function getPlayerState(
  identity: GameIdentity,
): Promise<PlayerState> {
  const db = getD1();
  await ensureSchema(db);
  const player = await ensurePlayer(db, identity);
  return loadPublicPlayer(db, player);
}

export async function saveDeck(
  identity: GameIdentity,
  input: {
    idempotencyKey: string;
    deck: {
      id?: string;
      name: string;
      cardIds: string[];
    };
  },
): Promise<SaveDeckResult> {
  const db = getD1();
  await ensureSchema(db);
  const player = await ensurePlayer(db, identity);
  const now = new Date().toISOString();
  const deckId =
    input.deck.id ?? `deck-${(await stableId(input.idempotencyKey)).slice(0, 12)}`;
  const requestedDeck: PlayerDeck = {
    id: deckId,
    name: input.deck.name,
    cardIds: [...input.deck.cardIds],
    updatedAt: now,
  };

  return commitMutation(
    db,
    player,
    "save_deck",
    input.idempotencyKey,
    { deck: requestedDeck },
    (current) => {
      const validation = validateDeck(requestedDeck.cardIds);
      if (!validation.valid) {
        throw new GameStoreError(
          "INVALID_DECK",
          "卡组不符合组牌规则。",
          400,
          validation.errors,
        );
      }
      assertCardsOwned(requestedDeck.cardIds, current.collection);

      const existingIndex = current.decks.findIndex(
        (deck) => deck.id === requestedDeck.id,
      );
      const decks = current.decks.map(cloneDeck);
      if (existingIndex >= 0) {
        decks[existingIndex] = requestedDeck;
      } else {
        if (decks.length >= 20) {
          throw new GameStoreError(
            "DECK_LIMIT_REACHED",
            "最多只能保存 20 套卡组。",
            409,
          );
        }
        decks.push(requestedDeck);
      }

      return {
        nextState: {
          ...current,
          decks,
          activeDeckId: requestedDeck.id,
        },
        result: { savedDeck: requestedDeck },
      };
    },
  ).then(({ player: nextPlayer, result, replayed }) => ({
    player: nextPlayer,
    savedDeck: result.savedDeck,
    replayed,
  }));
}

export async function claimTask(
  identity: GameIdentity,
  input: { idempotencyKey: string; taskId: string },
): Promise<ClaimTaskResult> {
  const db = getD1();
  await ensureSchema(db);
  const player = await ensurePlayer(db, identity);

  return commitMutation(
    db,
    player,
    "claim_task",
    input.idempotencyKey,
    { taskId: input.taskId },
    (current) => {
      const taskIndex = current.tasks.findIndex(
        (task) => task.id === input.taskId,
      );
      if (taskIndex < 0) {
        throw new GameStoreError("TASK_NOT_FOUND", "任务不存在。", 404);
      }

      const task = current.tasks[taskIndex];
      if (task.claimed) {
        throw new GameStoreError(
          "TASK_ALREADY_CLAIMED",
          "该任务奖励已经领取。",
          409,
        );
      }
      if (task.progress < task.target) {
        throw new GameStoreError(
          "TASK_NOT_COMPLETE",
          "任务尚未完成。",
          409,
        );
      }

      const tasks = current.tasks.map(cloneTask);
      tasks[taskIndex] = { ...task, claimed: true };
      return {
        nextState: {
          ...current,
          currencies: {
            ...current.currencies,
            gold: current.currencies.gold + task.rewardGold,
          },
          tasks,
        },
        result: {
          claimedTaskId: task.id,
          rewardGold: task.rewardGold,
        },
      };
    },
  ).then(({ player: nextPlayer, result, replayed }) => ({
    player: nextPlayer,
    claimedTaskId: result.claimedTaskId,
    rewardGold: result.rewardGold,
    replayed,
  }));
}

export async function openPack(
  identity: GameIdentity,
  input: { idempotencyKey: string },
): Promise<OpenPackResult> {
  const db = getD1();
  await ensureSchema(db);
  const player = await ensurePlayer(db, identity);
  let openedCards: Array<{ cardId: string; count: number }> = [];

  return commitMutation(
    db,
    player,
    "open_pack",
    input.idempotencyKey,
    {},
    (current) => {
      if (current.packsAvailable < 1) {
        throw new GameStoreError(
          "NO_PACKS_AVAILABLE",
          "没有可开启的卡包。",
          409,
        );
      }

      // Draw only after the availability check. This keeps an exhausted-pack
      // request side-effect free and makes retries easier to reason about.
      openedCards = drawPack();

      const collection = { ...current.collection };
      for (const opened of openedCards) {
        collection[opened.cardId] =
          (collection[opened.cardId] ?? 0) + opened.count;
      }

      return {
        nextState: {
          ...current,
          packsAvailable: current.packsAvailable - 1,
          collection,
          tasks: advanceTask(current.tasks, "open-one-pack", 1),
        },
        result: { openedCards },
      };
    },
  ).then(({ player: nextPlayer, result, replayed }) => ({
    player: nextPlayer,
    openedCards: result.openedCards,
    replayed,
  }));
}

export async function recordMatch(
  identity: GameIdentity,
  input: {
    idempotencyKey: string;
    result: MatchResult;
    mode: MatchMode;
    opponent: string;
  },
): Promise<RecordMatchResult> {
  const db = getD1();
  await ensureSchema(db);
  const player = await ensurePlayer(db, identity);
  const rewardGold =
    input.result === "win" ? WIN_REWARD_GOLD : LOSS_REWARD_GOLD;
  const match: MatchRecord = {
    id: `match-${(await stableId(`${player.id}|${input.idempotencyKey}`)).slice(0, 20)}`,
    result: input.result,
    mode: input.mode,
    opponent: input.opponent,
    rewardGold,
    createdAt: new Date().toISOString(),
  };

  return commitMutation(
    db,
    player,
    "record_match",
    input.idempotencyKey,
    {
      result: input.result,
      mode: input.mode,
      opponent: input.opponent,
    },
    (current) => ({
      nextState: {
        ...current,
        currencies: {
          ...current.currencies,
          gold: current.currencies.gold + rewardGold,
        },
        stats: {
          wins: current.stats.wins + (input.result === "win" ? 1 : 0),
          losses: current.stats.losses + (input.result === "loss" ? 1 : 0),
          matchesPlayed: current.stats.matchesPlayed + 1,
        },
        tasks: advanceMatchTasks(current.tasks, input.result),
      },
      result: { match },
      match,
    }),
  ).then(({ player: nextPlayer, result, replayed }) => ({
    player: nextPlayer,
    match: result.match,
    replayed,
  }));
}

export async function resetDemoPlayer(
  identity: GameIdentity,
): Promise<PlayerState> {
  if (!identity.isDemo) {
    throw new GameStoreError(
      "DEMO_ONLY",
      "只有本地演示账号可以重置。",
      403,
    );
  }

  const db = getD1();
  await ensureSchema(db);
  const player = await ensurePlayer(db, identity);
  const now = new Date().toISOString();
  const resetState = createDefaultState(now);
  const auditId = `audit-${crypto.randomUUID()}`;

  await db.batch([
    db
      .prepare("DELETE FROM match_records WHERE player_id = ?")
      .bind(player.id),
    db
      .prepare("DELETE FROM audit_events WHERE player_id = ?")
      .bind(player.id),
    db
      .prepare(
        `UPDATE player_states
         SET state_json = ?, version = version + 1, updated_at = ?
         WHERE player_id = ?`,
      )
      .bind(JSON.stringify(resetState), now, player.id),
    db
      .prepare(
        `INSERT INTO audit_events
           (id, player_id, action, idempotency_key, payload_json, result_json, created_at)
         VALUES (?, ?, 'reset_demo', NULL, '{}', '{"reset":true}', ?)`,
      )
      .bind(auditId, player.id, now),
  ]);

  return loadPublicPlayer(db, player);
}

async function commitMutation<T extends Record<string, unknown>>(
  db: D1DatabaseLike,
  player: PlayerRow,
  action: string,
  idempotencyKey: string,
  payload: Record<string, unknown>,
  mutate: (current: StoredPlayerState) => MutationOutput<T>,
): Promise<{ player: PlayerState; result: T; replayed: boolean }> {
  const existing = await findAudit(db, player.id, idempotencyKey);
  if (existing) {
    return replayAudit<T>(db, player, action, existing);
  }

  const auditId = `audit-${(
    await stableId(`${player.id}|${idempotencyKey}`)
  ).slice(0, 24)}`;

  for (let attempt = 0; attempt < MAX_MUTATION_ATTEMPTS; attempt += 1) {
    const row = await loadStateRow(db, player.id);
    const current = parseStoredState(row.stateJson);
    const { nextState, result, match } = mutate(cloneState(current));
    const nextStateJson = JSON.stringify(nextState);
    const resultJson = JSON.stringify(result);
    const now = new Date().toISOString();
    const nextVersion = row.version + 1;

    const statements = [
      db
        .prepare(
          `UPDATE player_states
           SET state_json = ?, version = ?, updated_at = ?
           WHERE player_id = ? AND version = ?`,
        )
        .bind(nextStateJson, nextVersion, now, player.id, row.version),
      db
        .prepare(
          `INSERT INTO audit_events
             (id, player_id, action, idempotency_key, payload_json, result_json, created_at)
           SELECT ?, ?, ?, ?, ?, ?, ?
           WHERE changes() = 1
             AND EXISTS (
             SELECT 1 FROM player_states
             WHERE player_id = ? AND version = ? AND state_json = ?
           )`,
        )
        .bind(
          auditId,
          player.id,
          action,
          idempotencyKey,
          JSON.stringify(payload),
          resultJson,
          now,
          player.id,
          nextVersion,
          nextStateJson,
        ),
    ];

    if (match) {
      statements.push(
        db
          .prepare(
            `INSERT INTO match_records
               (id, player_id, idempotency_key, result, mode, opponent, reward_gold, created_at)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?
             WHERE EXISTS (
               SELECT 1 FROM audit_events WHERE id = ?
             )`,
          )
          .bind(
            match.id,
            player.id,
            idempotencyKey,
            match.result,
            match.mode,
            match.opponent,
            match.rewardGold,
            match.createdAt,
            auditId,
          ),
      );
    }

    try {
      const results = await db.batch(statements);
      const auditInserted = (results[1]?.meta?.changes ?? 0) > 0;
      if (auditInserted) {
        return {
          player: await loadPublicPlayer(db, player),
          result,
          replayed: false,
        };
      }
    } catch (error) {
      const replay = await findAudit(db, player.id, idempotencyKey);
      if (replay) {
        return replayAudit<T>(db, player, action, replay);
      }
      if (attempt === MAX_MUTATION_ATTEMPTS - 1) throw error;
      continue;
    }

    const replay = await findAudit(db, player.id, idempotencyKey);
    if (replay) {
      return replayAudit<T>(db, player, action, replay);
    }
  }

  throw new GameStoreError(
    "STATE_CONFLICT",
    "玩家状态刚刚发生变化，请重试。",
    409,
  );
}

async function replayAudit<T>(
  db: D1DatabaseLike,
  player: PlayerRow,
  expectedAction: string,
  audit: AuditRow,
): Promise<{ player: PlayerState; result: T; replayed: boolean }> {
  if (audit.action !== expectedAction) {
    throw new GameStoreError(
      "IDEMPOTENCY_KEY_REUSED",
      "该幂等键已经用于其他操作。",
      409,
    );
  }

  let result: T;
  try {
    result = JSON.parse(audit.resultJson) as T;
  } catch {
    throw new GameStoreError(
      "CORRUPT_AUDIT_EVENT",
      "无法读取已完成操作的结果。",
      500,
    );
  }

  return {
    player: await loadPublicPlayer(db, player),
    result,
    replayed: true,
  };
}

async function findAudit(
  db: D1DatabaseLike,
  playerId: string,
  idempotencyKey: string,
): Promise<AuditRow | null> {
  return db
    .prepare(
      `SELECT action, result_json AS resultJson
       FROM audit_events
       WHERE player_id = ? AND idempotency_key = ?
       LIMIT 1`,
    )
    .bind(playerId, idempotencyKey)
    .first<AuditRow>();
}

async function ensurePlayer(
  db: D1DatabaseLike,
  identity: GameIdentity,
): Promise<PlayerRow> {
  const normalizedEmail = identity.email.trim().toLowerCase();
  const displayName = identity.displayName.trim() || normalizedEmail;
  const playerId = `player-${(await stableId(normalizedEmail)).slice(0, 24)}`;
  const now = new Date().toISOString();
  const defaultState = createDefaultState(now);

  await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO players
           (id, email, display_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(playerId, normalizedEmail, displayName, now, now),
    db
      .prepare(
        `INSERT OR IGNORE INTO player_states
           (player_id, state_json, version, updated_at)
         VALUES (?, ?, 1, ?)`,
      )
      .bind(playerId, JSON.stringify(defaultState), now),
    db
      .prepare(
        `UPDATE players
         SET display_name = ?, updated_at = ?
         WHERE email = ?`,
      )
      .bind(displayName, now, normalizedEmail),
  ]);

  const row = await db
    .prepare(
      `SELECT id, email, display_name AS displayName
       FROM players
       WHERE email = ?
       LIMIT 1`,
    )
    .bind(normalizedEmail)
    .first<PlayerRow>();

  if (!row) {
    throw new GameStoreError(
      "PLAYER_INITIALIZATION_FAILED",
      "无法初始化玩家数据。",
      500,
    );
  }
  return row;
}

async function loadPublicPlayer(
  db: D1DatabaseLike,
  player: PlayerRow,
): Promise<PlayerState> {
  const row = await loadStateRow(db, player.id);
  const stored = parseStoredState(row.stateJson);
  const matchResult = await db
    .prepare(
      `SELECT id, result, mode, opponent, reward_gold AS rewardGold,
              created_at AS createdAt
       FROM match_records
       WHERE player_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT 20`,
    )
    .bind(player.id)
    .all<MatchRow>();

  return {
    id: player.id,
    email: player.email,
    displayName: player.displayName,
    ...cloneState(stored),
    recentMatches: matchResult.results.map((match) => ({ ...match })),
    updatedAt: row.updatedAt,
  };
}

async function loadStateRow(
  db: D1DatabaseLike,
  playerId: string,
): Promise<StateRow> {
  const row = await db
    .prepare(
      `SELECT state_json AS stateJson, version, updated_at AS updatedAt
       FROM player_states
       WHERE player_id = ?
       LIMIT 1`,
    )
    .bind(playerId)
    .first<StateRow>();

  if (!row) {
    throw new GameStoreError(
      "PLAYER_STATE_NOT_FOUND",
      "玩家状态不存在。",
      500,
    );
  }
  return row;
}

function getD1(): D1DatabaseLike {
  const db = (env as unknown as { DB?: D1DatabaseLike }).DB;
  if (!db) {
    throw new GameStoreError(
      "DATABASE_UNAVAILABLE",
      "玩家数据库当前不可用。",
      503,
    );
  }
  return db;
}

async function ensureSchema(db: D1DatabaseLike): Promise<void> {
  if (!schemaReady) {
    schemaReady = initializeSchema(db).catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

async function initializeSchema(db: D1DatabaseLike): Promise<void> {
  await db.batch([
    db.prepare(
      `CREATE TABLE IF NOT EXISTS players (
        id TEXT PRIMARY KEY NOT NULL,
        email TEXT NOT NULL,
        display_name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
    ),
    db.prepare(
      `CREATE UNIQUE INDEX IF NOT EXISTS players_email_uidx
       ON players (email)`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS player_states (
        player_id TEXT PRIMARY KEY NOT NULL
          REFERENCES players(id) ON DELETE CASCADE,
        state_json TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS match_records (
        id TEXT PRIMARY KEY NOT NULL,
        player_id TEXT NOT NULL
          REFERENCES players(id) ON DELETE CASCADE,
        idempotency_key TEXT NOT NULL,
        result TEXT NOT NULL CHECK (result IN ('win', 'loss')),
        mode TEXT NOT NULL CHECK (mode IN ('ai', 'pvp')),
        opponent TEXT NOT NULL,
        reward_gold INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
    ),
    db.prepare(
      `CREATE UNIQUE INDEX IF NOT EXISTS match_records_player_idempotency_uidx
       ON match_records (player_id, idempotency_key)`,
    ),
    db.prepare(
      `CREATE INDEX IF NOT EXISTS match_records_player_created_idx
       ON match_records (player_id, created_at)`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY NOT NULL,
        player_id TEXT NOT NULL
          REFERENCES players(id) ON DELETE CASCADE,
        action TEXT NOT NULL,
        idempotency_key TEXT,
        payload_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
    ),
    db.prepare(
      `CREATE UNIQUE INDEX IF NOT EXISTS audit_events_player_idempotency_uidx
       ON audit_events (player_id, idempotency_key)`,
    ),
    db.prepare(
      `CREATE INDEX IF NOT EXISTS audit_events_player_created_idx
       ON audit_events (player_id, created_at)`,
    ),
  ]);
}

function createDefaultState(now: string): StoredPlayerState {
  const collection: Record<string, number> = {};
  for (const cardId of DEFAULT_STARTER_DECK) {
    collection[cardId] = (collection[cardId] ?? 0) + 1;
  }

  return {
    currencies: {
      gold: STARTING_GOLD,
      dust: 0,
    },
    packsAvailable: STARTING_PACKS,
    collection,
    decks: [
      {
        id: "starter-sun",
        name: "曙光远征队",
        cardIds: [...DEFAULT_STARTER_DECK],
        updatedAt: now,
      },
    ],
    activeDeckId: "starter-sun",
    tasks: [
      {
        id: "play-one-match",
        title: "初次交锋",
        description: "完成 1 场对战",
        progress: 0,
        target: 1,
        rewardGold: 80,
        claimed: false,
      },
      {
        id: "win-one-match",
        title: "旗开得胜",
        description: "赢得 1 场对战",
        progress: 0,
        target: 1,
        rewardGold: 120,
        claimed: false,
      },
      {
        id: "open-one-pack",
        title: "开拓收藏",
        description: "开启 1 个卡包",
        progress: 0,
        target: 1,
        rewardGold: 50,
        claimed: false,
      },
    ],
    stats: {
      wins: 0,
      losses: 0,
      matchesPlayed: 0,
    },
  };
}

function parseStoredState(value: string): StoredPlayerState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new GameStoreError(
      "CORRUPT_PLAYER_STATE",
      "玩家状态无法读取。",
      500,
    );
  }

  if (!isStoredState(parsed)) {
    throw new GameStoreError(
      "CORRUPT_PLAYER_STATE",
      "玩家状态格式无效。",
      500,
    );
  }
  return parsed;
}

function isStoredState(value: unknown): value is StoredPlayerState {
  if (!isRecord(value)) return false;
  if (
    !isRecord(value.currencies) ||
    !isFiniteNonNegativeInteger(value.currencies.gold) ||
    !isFiniteNonNegativeInteger(value.currencies.dust) ||
    !isFiniteNonNegativeInteger(value.packsAvailable) ||
    !isRecord(value.collection) ||
    !Array.isArray(value.decks) ||
    !Array.isArray(value.tasks) ||
    !isRecord(value.stats)
  ) {
    return false;
  }

  return (
    typeof value.activeDeckId === "string" &&
    value.decks.every(isDeck) &&
    value.tasks.every(isTask) &&
    Object.entries(value.collection).every(
      ([cardId, count]) =>
        isCardId(cardId) && isFiniteNonNegativeInteger(count),
    ) &&
    isFiniteNonNegativeInteger(value.stats.wins) &&
    isFiniteNonNegativeInteger(value.stats.losses) &&
    isFiniteNonNegativeInteger(value.stats.matchesPlayed)
  );
}

function isDeck(value: unknown): value is PlayerDeck {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.updatedAt === "string" &&
    Array.isArray(value.cardIds) &&
    value.cardIds.every(isCardId)
  );
}

function isTask(value: unknown): value is PlayerTask {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    typeof value.description === "string" &&
    isFiniteNonNegativeInteger(value.progress) &&
    isFiniteNonNegativeInteger(value.target) &&
    isFiniteNonNegativeInteger(value.rewardGold) &&
    typeof value.claimed === "boolean"
  );
}

function cloneState(state: StoredPlayerState): StoredPlayerState {
  return {
    currencies: { ...state.currencies },
    packsAvailable: state.packsAvailable,
    collection: { ...state.collection },
    decks: state.decks.map(cloneDeck),
    activeDeckId: state.activeDeckId,
    tasks: state.tasks.map(cloneTask),
    stats: { ...state.stats },
  };
}

function cloneDeck(deck: PlayerDeck): PlayerDeck {
  return { ...deck, cardIds: [...deck.cardIds] };
}

function cloneTask(task: PlayerTask): PlayerTask {
  return { ...task };
}

function advanceTask(
  tasks: PlayerTask[],
  taskId: string,
  amount: number,
): PlayerTask[] {
  return tasks.map((task) =>
    task.id === taskId && !task.claimed
      ? {
          ...task,
          progress: Math.min(task.target, task.progress + amount),
        }
      : cloneTask(task),
  );
}

function advanceMatchTasks(
  tasks: PlayerTask[],
  result: MatchResult,
): PlayerTask[] {
  let next = advanceTask(tasks, "play-one-match", 1);
  if (result === "win") {
    next = advanceTask(next, "win-one-match", 1);
  }
  return next;
}

function assertCardsOwned(
  cardIds: string[],
  collection: Record<string, number>,
): void {
  const requested = new Map<string, number>();
  for (const cardId of cardIds) {
    requested.set(cardId, (requested.get(cardId) ?? 0) + 1);
  }

  const missing = [...requested.entries()]
    .filter(([cardId, count]) => (collection[cardId] ?? 0) < count)
    .map(([cardId, count]) => ({
      cardId,
      requested: count,
      owned: collection[cardId] ?? 0,
    }));

  if (missing.length > 0) {
    throw new GameStoreError(
      "CARDS_NOT_OWNED",
      "卡组包含尚未拥有的卡牌。",
      400,
      missing,
    );
  }
}

function drawPack(): Array<{ cardId: string; count: number }> {
  if (CARD_CATALOG.length === 0) {
    throw new GameStoreError(
      "CARD_CATALOG_EMPTY",
      "卡牌目录尚未就绪。",
      503,
    );
  }

  const counts = new Map<string, number>();
  const random = new Uint32Array(5);
  crypto.getRandomValues(random);
  for (const value of random) {
    const card = CARD_CATALOG[value % CARD_CATALOG.length];
    counts.set(card.id, (counts.get(card.id) ?? 0) + 1);
  }

  return [...counts.entries()].map(([cardId, count]) => ({
    cardId,
    count,
  }));
}

async function stableId(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function isCardId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{1,63}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}
