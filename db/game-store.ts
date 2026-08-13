import { env } from "cloudflare:workers";
import {
  CARD_CATALOG,
  DEFAULT_STARTER_DECK,
  validateDeck,
} from "../lib/game";
import { drawPack } from "../lib/game/pack.ts";

export type MatchResult = "win" | "loss";
export type MatchMode = "ai" | "pvp";

export type GameIdentity = {
  email: string;
  displayName: string;
  isDemo: boolean;
  isAnonymous: boolean;
  /** Stable server-derived key used to bind PVP rewards to a participant. */
  identityKey?: string;
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
  rewardXp: number;
  period: "daily" | "weekly";
  claimed: boolean;
};

export type TaskCycle = {
  dayKey: string;
  weekKey: string;
  dailyRerollsRemaining: number;
  packsBoughtToday: number;
};

export type PlayerProgression = {
  xp: number;
  level: number;
};

export type PlayerLadder = {
  rating: number;
  tier: string;
  stars: number;
  wins: number;
  losses: number;
};

export type MatchRecord = {
  id: string;
  result: MatchResult;
  mode: MatchMode;
  opponent: string;
  rewardGold: number;
  pvpToken?: string;
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
  taskCycle: TaskCycle;
  progression: PlayerProgression;
  ladder: PlayerLadder;
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

export type BuyPackResult = {
  player: PlayerState;
  costGold: number;
  replayed: boolean;
};

export type RerollTaskResult = {
  player: PlayerState;
  task: PlayerTask;
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
  pvpToken?: string | null;
  createdAt: string;
};

type AuditRow = {
  action: string;
  resultJson: string;
};

type PvpMatchRow = {
  matchToken: string;
  stateJson: string;
};

type PvpParticipantRow = {
  hostIdentity: string;
  guestIdentity: string;
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
const PACK_PRICE_GOLD = 100;
const DAILY_PACK_PURCHASE_LIMIT = 10;
const MATCH_REWARD_XP = 100;
const PACK_REWARD_XP = 50;
const TASK_REWARD_XP = 150;
const DAILY_REROLL_LIMIT = 1;
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
  await refreshPlayerCycle(db, player);
  return loadPublicPlayer(db, player);
}

/**
 * Move a guest device profile into a newly authenticated account only when
 * the authenticated account is still pristine. This prevents silent merges
 * between two active collections while preserving the usual first-login flow.
 */
export async function linkAnonymousAccount(
  identity: GameIdentity,
  anonymousIdentity: GameIdentity,
): Promise<PlayerState> {
  if (identity.isAnonymous || !identity.identityKey || !anonymousIdentity.isAnonymous || !anonymousIdentity.identityKey) {
    throw new GameStoreError("ACCOUNT_LINK_INVALID", "当前身份不支持绑定本机档案。", 400);
  }
  if (identity.identityKey === anonymousIdentity.identityKey) return getPlayerState(identity);
  const db = getD1();
  await ensureSchema(db);
  const target = await ensurePlayer(db, identity);
  const sourceExisting = await db
    .prepare("SELECT id, email, display_name AS displayName FROM players WHERE identity_key = ? LIMIT 1")
    .bind(anonymousIdentity.identityKey)
    .first<PlayerRow>();
  if (!sourceExisting) return loadPublicPlayer(db, target);
  const source = sourceExisting;
  if (target.id === source.id) return loadPublicPlayer(db, target);

  const targetState = parseStoredState((await loadStateRow(db, target.id)).stateJson);
  const sourceState = parseStoredState((await loadStateRow(db, source.id)).stateJson);
  if (!isPristineState(targetState)) {
    throw new GameStoreError("ACCOUNT_LINK_CONFLICT", "云端档案已有进度，请先在账号中心处理合并。", 409);
  }
  const now = new Date().toISOString();
  await db.batch([
    db.prepare("UPDATE match_records SET player_id = ? WHERE player_id = ?").bind(target.id, source.id),
    db.prepare("UPDATE audit_events SET player_id = ? WHERE player_id = ?").bind(target.id, source.id),
    db.prepare("UPDATE player_states SET state_json = ?, version = version + 1, updated_at = ? WHERE player_id = ?")
      .bind(JSON.stringify(sourceState), now, target.id),
    db.prepare("DELETE FROM player_states WHERE player_id = ?").bind(source.id),
    db.prepare("DELETE FROM players WHERE id = ?").bind(source.id),
  ]);
  return loadPublicPlayer(db, target);
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
          progression: awardXp(current.progression, task.rewardXp),
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
      if (CARD_CATALOG.length === 0) {
        throw new GameStoreError(
          "CARD_CATALOG_EMPTY",
          "卡牌目录尚未就绪。",
          503,
        );
      }
      openedCards = drawPack(current.collection);

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
          tasks: advanceTasksMatching(current.tasks, (task) => task.description.includes("卡包"), 1),
          progression: awardXp(current.progression, PACK_REWARD_XP),
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

export async function buyPack(
  identity: GameIdentity,
  input: { idempotencyKey: string },
): Promise<BuyPackResult> {
  const db = getD1();
  await ensureSchema(db);
  const player = await ensurePlayer(db, identity);

  return commitMutation(
    db,
    player,
    "buy_pack",
    input.idempotencyKey,
    { costGold: PACK_PRICE_GOLD },
    (current) => {
      if (current.currencies.gold < PACK_PRICE_GOLD) {
        throw new GameStoreError("INSUFFICIENT_GOLD", "金币不足，无法购买卡包。", 409);
      }
      if (current.taskCycle.packsBoughtToday >= DAILY_PACK_PURCHASE_LIMIT) {
        throw new GameStoreError("SHOP_LIMIT_REACHED", `今日最多购买 ${DAILY_PACK_PURCHASE_LIMIT} 个卡包。`, 409);
      }
      return {
        nextState: {
          ...current,
          currencies: {
            ...current.currencies,
            gold: current.currencies.gold - PACK_PRICE_GOLD,
          },
          packsAvailable: current.packsAvailable + 1,
          taskCycle: {
            ...current.taskCycle,
            packsBoughtToday: current.taskCycle.packsBoughtToday + 1,
          },
        },
        result: { costGold: PACK_PRICE_GOLD },
      };
    },
  ).then(({ player: nextPlayer, result, replayed }) => ({
    player: nextPlayer,
    costGold: result.costGold,
    replayed,
  }));
}

export async function rerollTask(
  identity: GameIdentity,
  input: { idempotencyKey: string; taskId: string },
): Promise<RerollTaskResult> {
  const db = getD1();
  await ensureSchema(db);
  const player = await ensurePlayer(db, identity);

  return commitMutation(
    db,
    player,
    "reroll_task",
    input.idempotencyKey,
    { taskId: input.taskId },
    (current) => {
      const taskIndex = current.tasks.findIndex((task) => task.id === input.taskId);
      if (taskIndex < 0) throw new GameStoreError("TASK_NOT_FOUND", "任务不存在。", 404);
      const task = current.tasks[taskIndex];
      if (task.period !== "daily" || task.claimed || task.progress > 0) {
        throw new GameStoreError("TASK_NOT_REROLLABLE", "该任务当前不能重随。", 409);
      }
      if (current.taskCycle.dailyRerollsRemaining < 1) {
        throw new GameStoreError("TASK_REROLL_LIMIT", "今日重随次数已用完。", 409);
      }
      const replacement = makeRerolledTask(current, task.id);
      const tasks = current.tasks.map(cloneTask);
      tasks[taskIndex] = replacement;
      return {
        nextState: {
          ...current,
          tasks,
          taskCycle: {
            ...current.taskCycle,
            dailyRerollsRemaining: current.taskCycle.dailyRerollsRemaining - 1,
          },
        },
        result: { task: replacement },
      };
    },
  ).then(({ player: nextPlayer, result, replayed }) => ({
    player: nextPlayer,
    task: result.task,
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
    pvpToken?: string;
    pvpPlayer?: 0 | 1;
  },
): Promise<RecordMatchResult> {
  const db = getD1();
  await ensureSchema(db);
  const player = await ensurePlayer(db, identity);
  if (input.mode === "pvp") {
    if (!input.pvpToken || input.pvpPlayer === undefined) {
      throw new GameStoreError("PVP_PROOF_REQUIRED", "联机对局缺少服务器凭证。", 400);
    }
    const row = await db
      .prepare("SELECT match_token AS matchToken, state_json AS stateJson FROM pvp_matches WHERE match_token = ?")
      .bind(input.pvpToken)
      .first<PvpMatchRow>();
    if (!row) {
      throw new GameStoreError("PVP_PROOF_INVALID", "联机对局凭证无效或已过期。", 409);
    }
    let state: { phase?: string; result?: { winner?: number | null } };
    try {
      state = JSON.parse(row.stateJson) as typeof state;
    } catch {
      throw new GameStoreError("PVP_PROOF_INVALID", "联机对局状态无法验证。", 409);
    }
    const winner = state.phase === "game-over" ? state.result?.winner : null;
    if (winner !== 0 && winner !== 1) {
      throw new GameStoreError("PVP_NOT_FINISHED", "联机对局尚未结束。", 409);
    }
    const expectedResult: MatchResult = winner === input.pvpPlayer ? "win" : "loss";
    if (input.result !== expectedResult) {
      throw new GameStoreError("PVP_RESULT_MISMATCH", "对局结果与服务器战报不一致。", 409);
    }
    const participant = await db
      .prepare("SELECT host_identity AS hostIdentity, guest_identity AS guestIdentity FROM pvp_match_participants WHERE match_token = ?")
      .bind(input.pvpToken)
      .first<PvpParticipantRow>();
    const participantIdentity = input.pvpPlayer === 0
      ? participant?.hostIdentity
      : participant?.guestIdentity;
    if (!participantIdentity || !identity.identityKey || participantIdentity !== identity.identityKey) {
      throw new GameStoreError("PVP_OWNER_MISMATCH", "该对局不属于当前玩家身份。", 403);
    }
    const settled = await db
      .prepare("SELECT id FROM match_records WHERE player_id = ? AND pvp_token = ? LIMIT 1")
      .bind(player.id, input.pvpToken)
      .first<{ id: string }>();
    if (settled) {
      throw new GameStoreError("PVP_ALREADY_SETTLED", "该联机对局已经结算过。", 409);
    }
  }
  const rewardGold =
    input.result === "win" ? WIN_REWARD_GOLD : LOSS_REWARD_GOLD;
  const match: MatchRecord = {
    id: `match-${(await stableId(`${player.id}|${input.idempotencyKey}`)).slice(0, 20)}`,
    result: input.result,
    mode: input.mode,
    opponent: input.opponent,
    rewardGold,
    ...(input.pvpToken ? { pvpToken: input.pvpToken } : {}),
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
      ...(input.pvpToken ? { pvpToken: input.pvpToken } : {}),
      ...(input.pvpPlayer === undefined ? {} : { pvpPlayer: input.pvpPlayer }),
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
        progression: awardXp(current.progression, MATCH_REWARD_XP),
        ladder: input.mode === "pvp" ? updateLadder(current.ladder, input.result) : current.ladder,
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
    const refreshed = refreshTaskCycle(cloneState(current), new Date().toISOString());
    const { nextState, result, match } = mutate(refreshed);
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
               (id, player_id, idempotency_key, pvp_token, result, mode, opponent, reward_gold, created_at)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
             WHERE EXISTS (
               SELECT 1 FROM audit_events WHERE id = ?
             )`,
          )
          .bind(
            match.id,
            player.id,
            idempotencyKey,
            match.pvpToken ?? null,
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
  // Prefer the platform's stable subject (or the durable anonymous-device
  // key) over an email address. Email can change; the identity key is what
  // keeps a player's collection, decks and match history attached to them.
  const identityKey = identity.identityKey?.trim() || `email:${normalizedEmail}`;
  const now = new Date().toISOString();
  const defaultState = createDefaultState(now);

  const byIdentity = await db
    .prepare(
      `SELECT id, email, display_name AS displayName
       FROM players
       WHERE identity_key = ?
       LIMIT 1`,
    )
    .bind(identityKey)
    .first<PlayerRow>();
  // Email is a display/contact attribute, not an account key. Only claim an
  // email row when it is an old pre-identity record (or the synthetic
  // email-based identity created by an earlier build). If another stable
  // identity already owns the same email, create/resolve a separate player
  // instead of silently moving that account's collection to this user.
  const legacyByEmail = byIdentity
    ? null
    : await db
        .prepare(
          `SELECT id, email, display_name AS displayName
           FROM players
           WHERE email = ?
             AND (identity_key IS NULL OR identity_key = ?)
           LIMIT 1`,
        )
        .bind(normalizedEmail, `email:${normalizedEmail}`)
        .first<PlayerRow>();
  const existing = byIdentity ?? legacyByEmail;

  if (existing) {
    // Backfill legacy email-based rows on first access. If the authenticated
    // email changes, keep the old row and update its display metadata.
    await db
      .prepare(
        `UPDATE players
         SET email = ?, identity_key = ?, display_name = ?, updated_at = ?
         WHERE id = ?`,
      )
      .bind(normalizedEmail, identityKey, displayName, now, existing.id)
      .run();
    return { ...existing, email: normalizedEmail, displayName };
  }

  const playerId = `player-${(await stableId(identityKey)).slice(0, 24)}`;

  await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO players
           (id, email, identity_key, display_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(playerId, normalizedEmail, identityKey, displayName, now, now),
    db
      .prepare(
        `INSERT OR IGNORE INTO player_states
           (player_id, state_json, version, updated_at)
         VALUES (?, ?, 1, ?)`,
      )
      .bind(playerId, JSON.stringify(defaultState), now),
  ]);

  const row = await db
    .prepare(
      `SELECT id, email, display_name AS displayName
       FROM players
       WHERE identity_key = ?
       LIMIT 1`,
    )
    .bind(identityKey)
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
              pvp_token AS pvpToken,
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
    recentMatches: matchResult.results.map(({ pvpToken: _pvpToken, ...match }) => ({ ...match })),
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
        identity_key TEXT,
        display_name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
    ),
    // Email addresses are not guaranteed to be unique across platform
    // identities. Stable identity_key ownership is enforced separately.
    db.prepare(`DROP INDEX IF EXISTS players_email_uidx`),
    db.prepare(`CREATE INDEX IF NOT EXISTS players_email_idx ON players (email)`),
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
        pvp_token TEXT,
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
    // PVP match snapshots are written by the polling worker and verified here
    // before a client can turn a result into ranked/profile rewards.
    db.prepare(
      `CREATE TABLE IF NOT EXISTS pvp_matches (
        room_code TEXT PRIMARY KEY NOT NULL,
        match_token TEXT NOT NULL,
        state_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    ),
    db.prepare(
      `CREATE UNIQUE INDEX IF NOT EXISTS pvp_matches_token_uidx
       ON pvp_matches (match_token)`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS pvp_match_participants (
        match_token TEXT PRIMARY KEY NOT NULL,
        room_code TEXT NOT NULL,
        host_identity TEXT NOT NULL,
        guest_identity TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
    ),
    db.prepare(
      `CREATE INDEX IF NOT EXISTS pvp_match_participants_created_idx
       ON pvp_match_participants (created_at)`,
    ),
  ]);

  // Existing deployments were created before identity_key was introduced.
  // SQLite/D1 has no IF NOT EXISTS form for ADD COLUMN, so make the migration
  // idempotent by treating the already-present-column error as success.
  try {
    await db.prepare("ALTER TABLE players ADD COLUMN identity_key TEXT").run();
  } catch {
    // Column already exists on new installations or a previous migration.
  }
  await db.prepare(
    `CREATE UNIQUE INDEX IF NOT EXISTS players_identity_key_uidx
       ON players (identity_key)
       WHERE identity_key IS NOT NULL`,
  ).run();
  try {
    await db.prepare("ALTER TABLE match_records ADD COLUMN pvp_token TEXT").run();
  } catch {
    // Column already exists on new installations or a previous migration.
  }
  await db.prepare(
    `CREATE UNIQUE INDEX IF NOT EXISTS match_records_player_pvp_token_uidx
       ON match_records (player_id, pvp_token)
       WHERE pvp_token IS NOT NULL`,
  ).run();
  // Older deployments may have created the email uniqueness index in a
  // previous request before the migration batch above ran.
  await db.prepare(`DROP INDEX IF EXISTS players_email_uidx`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS players_email_idx ON players (email)`).run();
}

function createDefaultState(now: string): StoredPlayerState {
  const collection: Record<string, number> = {};
  const dayKey = utcDayKey(now);
  const weekKey = utcWeekKey(now);
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
        rewardXp: TASK_REWARD_XP,
        period: "daily",
        claimed: false,
      },
      {
        id: "win-one-match",
        title: "旗开得胜",
        description: "赢得 1 场对战",
        progress: 0,
        target: 1,
        rewardGold: 120,
        rewardXp: TASK_REWARD_XP,
        period: "daily",
        claimed: false,
      },
      {
        id: "open-one-pack",
        title: "开拓收藏",
        description: "开启 1 个卡包",
        progress: 0,
        target: 1,
        rewardGold: 50,
        rewardXp: TASK_REWARD_XP,
        period: "daily",
        claimed: false,
      },
      {
        id: "weekly-win-five",
        title: "周常·战术胜利",
        description: "赢得 5 场对战",
        progress: 0,
        target: 5,
        rewardGold: 250,
        rewardXp: 500,
        period: "weekly",
        claimed: false,
      },
    ],
    taskCycle: {
      dayKey,
      weekKey,
      dailyRerollsRemaining: DAILY_REROLL_LIMIT,
      packsBoughtToday: 0,
    },
    progression: { xp: 0, level: 1 },
    ladder: { rating: 1000, tier: "青铜", stars: 0, wins: 0, losses: 0 },
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

  const normalized = normalizeStoredState(parsed);
  if (!normalized || !isStoredState(normalized)) {
    throw new GameStoreError(
      "CORRUPT_PLAYER_STATE",
      "玩家状态格式无效。",
      500,
    );
  }
  return normalized;
}

function normalizeStoredState(value: unknown): StoredPlayerState | null {
  if (!isRecord(value)) return null;
  const tasks = Array.isArray(value.tasks)
    ? value.tasks.map((task) => {
        if (!isRecord(task)) return task;
        return {
          ...task,
          rewardXp: typeof task.rewardXp === "number" ? task.rewardXp : TASK_REWARD_XP,
          period: task.period === "weekly" ? "weekly" : "daily",
        };
      })
    : value.tasks;
  const taskCycle = isRecord(value.taskCycle)
    ? {
        dayKey: typeof value.taskCycle.dayKey === "string" ? value.taskCycle.dayKey : "",
        weekKey: typeof value.taskCycle.weekKey === "string" ? value.taskCycle.weekKey : "",
        dailyRerollsRemaining: isFiniteNonNegativeInteger(value.taskCycle.dailyRerollsRemaining)
          ? value.taskCycle.dailyRerollsRemaining
          : DAILY_REROLL_LIMIT,
        packsBoughtToday: isFiniteNonNegativeInteger(value.taskCycle.packsBoughtToday)
          ? value.taskCycle.packsBoughtToday
          : 0,
      }
    : { dayKey: "", weekKey: "", dailyRerollsRemaining: DAILY_REROLL_LIMIT, packsBoughtToday: 0 };
  const progression = isRecord(value.progression)
    ? {
        xp: isFiniteNonNegativeInteger(value.progression.xp) ? value.progression.xp : 0,
        level: isFiniteNonNegativeInteger(value.progression.level) && value.progression.level > 0
          ? value.progression.level
          : 1,
      }
    : { xp: 0, level: 1 };
  const ladder = isRecord(value.ladder)
    ? {
        rating: isFiniteNonNegativeInteger(value.ladder.rating) ? value.ladder.rating : 1000,
        tier: typeof value.ladder.tier === "string" ? value.ladder.tier : "青铜",
        stars: isFiniteNonNegativeInteger(value.ladder.stars) ? value.ladder.stars : 0,
        wins: isFiniteNonNegativeInteger(value.ladder.wins) ? value.ladder.wins : 0,
        losses: isFiniteNonNegativeInteger(value.ladder.losses) ? value.ladder.losses : 0,
      }
    : { rating: 1000, tier: "青铜", stars: 0, wins: 0, losses: 0 };
  return { ...value, tasks, taskCycle, progression, ladder } as StoredPlayerState;
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
    isTaskCycle(value.taskCycle) &&
    isProgression(value.progression) &&
    isLadder(value.ladder) &&
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

function isTaskCycle(value: unknown): value is TaskCycle {
  return (
    isRecord(value) &&
    typeof value.dayKey === "string" &&
    typeof value.weekKey === "string" &&
    isFiniteNonNegativeInteger(value.dailyRerollsRemaining) &&
    isFiniteNonNegativeInteger(value.packsBoughtToday)
  );
}

function isProgression(value: unknown): value is PlayerProgression {
  return isRecord(value) && isFiniteNonNegativeInteger(value.xp) && isFiniteNonNegativeInteger(value.level) && value.level > 0;
}

function isLadder(value: unknown): value is PlayerLadder {
  return (
    isRecord(value) &&
    isFiniteNonNegativeInteger(value.rating) &&
    typeof value.tier === "string" &&
    isFiniteNonNegativeInteger(value.stars) &&
    isFiniteNonNegativeInteger(value.wins) &&
    isFiniteNonNegativeInteger(value.losses)
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
    isFiniteNonNegativeInteger(value.rewardXp) &&
    (value.period === "daily" || value.period === "weekly") &&
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
    taskCycle: { ...state.taskCycle },
    progression: { ...state.progression },
    ladder: { ...state.ladder },
    stats: { ...state.stats },
  };
}

function cloneDeck(deck: PlayerDeck): PlayerDeck {
  return { ...deck, cardIds: [...deck.cardIds] };
}

function cloneTask(task: PlayerTask): PlayerTask {
  return { ...task };
}

function isPristineState(state: StoredPlayerState): boolean {
  const starter = new Map<string, number>();
  DEFAULT_STARTER_DECK.forEach((cardId) => starter.set(cardId, (starter.get(cardId) ?? 0) + 1));
  const collectionKeys = Object.keys(state.collection).filter((cardId) => state.collection[cardId] > 0);
  return (
    state.currencies.gold === STARTING_GOLD &&
    state.currencies.dust === 0 &&
    state.packsAvailable === STARTING_PACKS &&
    collectionKeys.length === starter.size &&
    collectionKeys.every((cardId) => state.collection[cardId] === starter.get(cardId)) &&
    state.decks.length === 1 &&
    state.decks[0]?.id === "starter-sun" &&
    state.stats.wins === 0 &&
    state.stats.losses === 0 &&
    state.stats.matchesPlayed === 0 &&
    state.progression.xp === 0 &&
    state.ladder.rating === 1000 &&
    state.tasks.every((task) => task.progress === 0 && !task.claimed)
  );
}

function awardXp(progression: PlayerProgression, amount: number): PlayerProgression {
  const xp = progression.xp + amount;
  return { xp, level: Math.floor(xp / 1000) + 1 };
}

function updateLadder(ladder: PlayerLadder, result: MatchResult): PlayerLadder {
  const rating = Math.max(0, ladder.rating + (result === "win" ? 25 : -20));
  const tier = rating >= 1800 ? "传说" : rating >= 1600 ? "钻石" : rating >= 1400 ? "白金" : rating >= 1200 ? "黄金" : rating >= 1000 ? "白银" : "青铜";
  return {
    rating,
    tier,
    stars: Math.floor((rating % 200) / 50),
    wins: ladder.wins + (result === "win" ? 1 : 0),
    losses: ladder.losses + (result === "loss" ? 1 : 0),
  };
}

function advanceMatchTasks(
  tasks: PlayerTask[],
  result: MatchResult,
): PlayerTask[] {
  let next = advanceTasksMatching(tasks, (task) => task.description.includes("对战"), 1);
  if (result === "win") {
    next = advanceTasksMatching(next, (task) => task.description.includes("赢得"), 1);
  }
  return next;
}

function advanceTasksMatching(
  tasks: PlayerTask[],
  predicate: (task: PlayerTask) => boolean,
  amount: number,
): PlayerTask[] {
  return tasks.map((task) =>
    predicate(task) && !task.claimed
      ? { ...task, progress: Math.min(task.target, task.progress + amount) }
      : cloneTask(task),
  );
}

function refreshTaskCycle(state: StoredPlayerState, now: string): StoredPlayerState {
  const dayKey = utcDayKey(now);
  const weekKey = utcWeekKey(now);
  const firstLoad = !state.taskCycle.dayKey || !state.taskCycle.weekKey;
  const dayChanged = !firstLoad && state.taskCycle.dayKey !== dayKey;
  const weekChanged = !firstLoad && state.taskCycle.weekKey !== weekKey;
  if (!dayChanged && !weekChanged && !firstLoad) return state;

  let tasks = state.tasks.map(cloneTask);
  if (dayChanged || firstLoad) {
    const daily = createDailyTasks();
    tasks = [...tasks.filter((task) => task.period !== "daily"), ...daily];
  }
  if (weekChanged || firstLoad) {
    const weekly = createWeeklyTasks();
    tasks = [...tasks.filter((task) => task.period !== "weekly"), ...weekly];
  }
  return {
    ...state,
    tasks,
    taskCycle: {
      dayKey,
      weekKey,
      dailyRerollsRemaining: dayChanged || firstLoad ? DAILY_REROLL_LIMIT : state.taskCycle.dailyRerollsRemaining,
      packsBoughtToday: dayChanged || firstLoad ? 0 : state.taskCycle.packsBoughtToday,
    },
  };
}

function createDailyTasks(): PlayerTask[] {
  return [
    {
      id: "play-one-match",
      title: "初次交锋",
      description: "完成 1 场对战",
      progress: 0,
      target: 1,
      rewardGold: 80,
      rewardXp: TASK_REWARD_XP,
      period: "daily",
      claimed: false,
    },
    {
      id: "win-one-match",
      title: "旗开得胜",
      description: "赢得 1 场对战",
      progress: 0,
      target: 1,
      rewardGold: 120,
      rewardXp: TASK_REWARD_XP,
      period: "daily",
      claimed: false,
    },
    {
      id: "open-one-pack",
      title: "开拓收藏",
      description: "开启 1 个卡包",
      progress: 0,
      target: 1,
      rewardGold: 50,
      rewardXp: TASK_REWARD_XP,
      period: "daily",
      claimed: false,
    },
  ];
}

function createWeeklyTasks(): PlayerTask[] {
  return [{
    id: "weekly-win-five",
    title: "周常·战术胜利",
    description: "赢得 5 场对战",
    progress: 0,
    target: 5,
    rewardGold: 250,
    rewardXp: 500,
    period: "weekly",
    claimed: false,
  }];
}

function makeRerolledTask(state: StoredPlayerState, previousId: string): PlayerTask {
  const pool: PlayerTask[] = [
    { id: "play-three-matches", title: "持续交锋", description: "完成 3 场对战", progress: 0, target: 3, rewardGold: 100, rewardXp: TASK_REWARD_XP, period: "daily", claimed: false },
    { id: "win-two-matches", title: "连胜协议", description: "赢得 2 场对战", progress: 0, target: 2, rewardGold: 150, rewardXp: TASK_REWARD_XP, period: "daily", claimed: false },
    { id: "open-two-packs", title: "档案解密", description: "开启 2 个卡包", progress: 0, target: 2, rewardGold: 100, rewardXp: TASK_REWARD_XP, period: "daily", claimed: false },
  ];
  const index = (state.stats.matchesPlayed + state.taskCycle.packsBoughtToday + state.tasks.length) % pool.length;
  const candidate = pool[index];
  return candidate.id === previousId ? pool[(index + 1) % pool.length] : candidate;
}

function utcDayKey(value: string): string {
  return value.slice(0, 10);
}

function utcWeekKey(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown-week";
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - day + 1);
  return date.toISOString().slice(0, 10);
}

async function refreshPlayerCycle(db: D1DatabaseLike, player: PlayerRow): Promise<void> {
  for (let attempt = 0; attempt < MAX_MUTATION_ATTEMPTS; attempt += 1) {
    const row = await loadStateRow(db, player.id);
    const current = parseStoredState(row.stateJson);
    const next = refreshTaskCycle(cloneState(current), new Date().toISOString());
    if (JSON.stringify(next) === JSON.stringify(current)) return;
    const result = await db
      .prepare(
        `UPDATE player_states SET state_json = ?, version = ?, updated_at = ?
         WHERE player_id = ? AND version = ?`,
      )
      .bind(JSON.stringify(next), row.version + 1, new Date().toISOString(), player.id, row.version)
      .run();
    if ((result.meta?.changes ?? 0) > 0) return;
  }
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
