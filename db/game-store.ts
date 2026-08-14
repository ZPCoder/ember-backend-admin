import { env } from "cloudflare:workers";
import {
  AI_ARCHETYPES,
  CARD_CATALOG,
  DEFAULT_STARTER_DECK,
  applyCommand,
  createMatch,
  validateDeck,
} from "../lib/game";
import type { BattleCommand } from "../lib/game";
import { drawPack } from "../lib/game/pack.ts";
import {
  REWARD_TRACK,
  craftCost,
  disenchantValue,
} from "../lib/game/economy.ts";

export type MatchResult = "win" | "loss";
export type MatchMode = "ai" | "pvp";
export type MatchFormat = "ranked" | "casual";

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
  aiRewardsToday: number;
  weeklyFreePackClaimed: boolean;
};

export type PackPityState = {
  packsOpened: number;
  packsSinceLegendary: number;
};

export type PlayerProgression = {
  xp: number;
  level: number;
};

export type RewardTrackState = {
  claimedLevels: number[];
};

export type PlayerLadder = {
  seasonKey: string;
  rating: number;
  tier: string;
  stars: number;
  wins: number;
  losses: number;
  highestRating: number;
};

export type FriendSummary = {
  id: string;
  displayName: string;
  status: "pending" | "accepted";
  direction: "incoming" | "outgoing";
};

export type SocialMessage = {
  id: string;
  senderId: string;
  recipientId: string;
  text: string;
  createdAt: string;
};

export type MatchRecord = {
  id: string;
  result: MatchResult;
  mode: MatchMode;
  format?: MatchFormat;
  opponent: string;
  rewardGold: number;
  pvpToken?: string;
  createdAt: string;
};

/** Client transcript that the server replays before granting AI rewards. */
export type AiMatchProof = {
  seed: number;
  startingPlayer: 0 | 1;
  playerDeck: string[];
  opponentArchetypeId: string;
  commands: BattleCommand[];
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
  packPity: PackPityState;
  collection: Record<string, number>;
  decks: PlayerDeck[];
  activeDeckId: string;
  tasks: PlayerTask[];
  taskCycle: TaskCycle;
  progression: PlayerProgression;
  rewardTrack: RewardTrackState;
  ladder: PlayerLadder;
  friends?: FriendSummary[];
  chatMessages?: SocialMessage[];
  blockedPlayerIds?: string[];
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

export type ClaimWeeklyPackResult = {
  player: PlayerState;
  replayed: boolean;
};

export type UpdateProfileResult = {
  player: PlayerState;
  displayName: string;
  replayed: boolean;
};

export type FriendMutationResult = {
  player: PlayerState;
  friendId: string;
  replayed: boolean;
};

export type ChatMutationResult = {
  player: PlayerState;
  message: SocialMessage;
  replayed: boolean;
};

export type SocialActionResult = {
  player: PlayerState;
  targetId: string;
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

export type CardEconomyResult = {
  player: PlayerState;
  cardId: string;
  amount: number;
  kind: "craft" | "disenchant";
  replayed: boolean;
};

export type ClaimRewardResult = {
  player: PlayerState;
  level: number;
  reward: { title: string; kind: "gold" | "pack" | "dust"; amount: number };
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
  format?: MatchFormat | null;
  opponent: string;
  rewardGold: number;
  pvpToken?: string | null;
  createdAt: string;
};

type AuditRow = {
  action: string;
  resultJson: string;
};

type FriendLinkRow = {
  id: string;
  playerA: string;
  playerB: string;
  status: "pending" | "accepted";
  requestedBy: string;
};

type SocialMessageRow = {
  id: string;
  senderId: string;
  recipientId: string;
  text: string;
  createdAt: string;
};

type PvpMatchRow = {
  matchToken: string;
  stateJson: string;
  format?: MatchFormat | null;
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
const DAILY_AI_REWARD_LIMIT = 20;
const MATCH_REWARD_XP = 100;
const PACK_REWARD_XP = 50;
const TASK_REWARD_XP = 150;
const DAILY_REROLL_LIMIT = 1;
const LEGENDARY_PITY_LIMIT = 40;
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
      const guaranteeLegendary = current.packPity.packsSinceLegendary >= LEGENDARY_PITY_LIMIT - 1;
      openedCards = drawPack(current.collection, undefined, { guaranteeLegendary });
      const openedLegendary = openedCards.some((opened) => CARD_CATALOG.find((card) => card.id === opened.cardId)?.rarity === "传说");

      const collection = { ...current.collection };
      for (const opened of openedCards) {
        collection[opened.cardId] =
          (collection[opened.cardId] ?? 0) + opened.count;
      }

      return {
        nextState: {
          ...current,
          packsAvailable: current.packsAvailable - 1,
          packPity: {
            packsOpened: current.packPity.packsOpened + 1,
            packsSinceLegendary: openedLegendary ? 0 : current.packPity.packsSinceLegendary + 1,
          },
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

/** Hearthstone-style weekly shop gift: one free pack per UTC week. */
export async function claimWeeklyPack(
  identity: GameIdentity,
  input: { idempotencyKey: string },
): Promise<ClaimWeeklyPackResult> {
  const db = getD1();
  await ensureSchema(db);
  const player = await ensurePlayer(db, identity);
  return commitMutation(
    db,
    player,
    "claim_weekly_pack",
    input.idempotencyKey,
    {},
    (current) => {
      if (current.taskCycle.weeklyFreePackClaimed) {
        throw new GameStoreError("WEEKLY_PACK_ALREADY_CLAIMED", "本周免费卡包已经领取。", 409);
      }
      return {
        nextState: {
          ...current,
          packsAvailable: current.packsAvailable + 1,
          taskCycle: { ...current.taskCycle, weeklyFreePackClaimed: true },
        },
        result: {},
      };
    },
  ).then(({ player: nextPlayer, replayed }) => ({ player: nextPlayer, replayed }));
}

/**
 * Update the public player name without changing the platform identity.
 * Hearthstone/Battle.net separates the account subject from the visible
 * profile name; keeping that distinction here prevents a later auth refresh
 * from silently overwriting a player's chosen name.
 */
export async function updateProfile(
  identity: GameIdentity,
  input: { idempotencyKey: string; displayName: string },
): Promise<UpdateProfileResult> {
  const db = getD1();
  await ensureSchema(db);
  const player = await ensurePlayer(db, identity);
  const displayName = normalizeDisplayName(input.displayName);
  const existingAudit = await findAudit(db, player.id, input.idempotencyKey);
  if (existingAudit) {
    if (existingAudit.action !== "update_profile") {
      throw new GameStoreError("IDEMPOTENCY_KEY_REUSED", "该幂等键已经用于其他操作。", 409);
    }
    const replay = parseProfileAudit(existingAudit.resultJson);
    return {
      player: await loadPublicPlayer(db, player),
      displayName: replay.displayName,
      replayed: true,
    };
  }

  const now = new Date().toISOString();
  const auditId = `audit-${(await stableId(`${player.id}|${input.idempotencyKey}`)).slice(0, 24)}`;
  const resultJson = JSON.stringify({ displayName });
  const results = await db.batch([
    db.prepare(
      `INSERT OR IGNORE INTO audit_events
         (id, player_id, action, idempotency_key, payload_json, result_json, created_at)
       VALUES (?, ?, 'update_profile', ?, ?, ?, ?)`,
    ).bind(auditId, player.id, input.idempotencyKey, JSON.stringify({ displayName }), resultJson, now),
    db.prepare(
      `UPDATE players
       SET display_name = ?, updated_at = ?
       WHERE id = ? AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)`,
    ).bind(displayName, now, player.id, auditId),
  ]);
  if ((results[0]?.meta?.changes ?? 0) === 0) {
    const replay = await findAudit(db, player.id, input.idempotencyKey);
    if (!replay) throw new GameStoreError("STATE_CONFLICT", "玩家档案刚刚发生变化，请重试。", 409);
    if (replay.action !== "update_profile") {
      throw new GameStoreError("IDEMPOTENCY_KEY_REUSED", "该幂等键已经用于其他操作。", 409);
    }
    const parsed = parseProfileAudit(replay.resultJson);
    const latest = await getPlayerRow(db, player.id);
    return { player: await loadPublicPlayer(db, latest), displayName: parsed.displayName, replayed: true };
  }
  const latest = await getPlayerRow(db, player.id);
  return { player: await loadPublicPlayer(db, latest), displayName, replayed: false };
}

/** Send a Hearthstone-style friend request using the public player UID. */
export async function sendFriendRequest(
  identity: GameIdentity,
  input: { idempotencyKey: string; friendId: string },
): Promise<FriendMutationResult> {
  return mutateFriendLink(identity, input, "send");
}

/** Accept an incoming request; the caller must be the requested recipient. */
export async function acceptFriendRequest(
  identity: GameIdentity,
  input: { idempotencyKey: string; friendId: string },
): Promise<FriendMutationResult> {
  return mutateFriendLink(identity, input, "accept");
}

async function mutateFriendLink(
  identity: GameIdentity,
  input: { idempotencyKey: string; friendId: string },
  operation: "send" | "accept",
): Promise<FriendMutationResult> {
  const db = getD1();
  await ensureSchema(db);
  const player = await ensurePlayer(db, identity);
  const friendId = input.friendId.trim();
  if (!/^player-[A-Za-z0-9_-]{6,80}$/.test(friendId)) {
    throw new GameStoreError("INVALID_FRIEND_ID", "好友 UID 格式无效。", 400);
  }
  if (friendId === player.id) {
    throw new GameStoreError("FRIEND_SELF_REQUEST", "不能添加自己为好友。", 400);
  }
  const friend = await getPlayerRow(db, friendId);
  if (await isSocialBlocked(db, player.id, friend.id)) {
    throw new GameStoreError("FRIEND_BLOCKED", "该玩家已被屏蔽，无法建立好友关系。", 403);
  }
  const existingAudit = await findAudit(db, player.id, input.idempotencyKey);
  if (existingAudit) {
    if (existingAudit.action !== `friend_${operation}`) {
      throw new GameStoreError("IDEMPOTENCY_KEY_REUSED", "该幂等键已经用于其他操作。", 409);
    }
    return { player: await loadPublicPlayer(db, player), friendId: parseFriendAudit(existingAudit.resultJson), replayed: true };
  }

  const [playerA, playerB] = [player.id, friend.id].sort();
  const linkId = `friend-${(await stableId(`${playerA}|${playerB}`)).slice(0, 24)}`;
  const link = await getFriendLink(db, playerA, playerB);
  const now = new Date().toISOString();
  if (operation === "send" && link?.status === "accepted") {
    throw new GameStoreError("FRIEND_ALREADY_EXISTS", "该玩家已经在好友列表中。", 409);
  }
  if (operation === "send" && link?.status === "pending" && link.requestedBy === player.id) {
    throw new GameStoreError("FRIEND_REQUEST_PENDING", "好友请求已发送，等待对方确认。", 409);
  }
  if (operation === "accept" && (!link || link.status !== "pending" || link.requestedBy === player.id)) {
    throw new GameStoreError("FRIEND_REQUEST_INVALID", "没有可接受的入站好友请求。", 409);
  }

  const action = `friend_${operation}`;
  const auditId = `audit-${(await stableId(`${player.id}|${input.idempotencyKey}`)).slice(0, 24)}`;
  const resultJson = JSON.stringify({ friendId: friend.id });
  const socialStatement = operation === "accept"
    ? db.prepare(
        `UPDATE friend_links
         SET status = 'accepted', updated_at = ?
         WHERE player_a = ? AND player_b = ? AND status = 'pending' AND requested_by <> ?`,
      ).bind(now, playerA, playerB, player.id)
    : link?.status === "pending"
      ? db.prepare(
          `UPDATE friend_links
           SET status = 'accepted', updated_at = ?
           WHERE player_a = ? AND player_b = ? AND status = 'pending' AND requested_by <> ?`,
        ).bind(now, playerA, playerB, player.id)
      : db.prepare(
          `INSERT INTO friend_links
             (id, player_a, player_b, status, requested_by, created_at, updated_at)
           VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
        ).bind(linkId, playerA, playerB, player.id, now, now);
  const results = await db.batch([
    db.prepare(
      `INSERT OR IGNORE INTO audit_events
         (id, player_id, action, idempotency_key, payload_json, result_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(auditId, player.id, action, input.idempotencyKey, JSON.stringify({ friendId: friend.id }), resultJson, now),
    socialStatement,
  ]);
  if ((results[0]?.meta?.changes ?? 0) === 0) {
    const replay = await findAudit(db, player.id, input.idempotencyKey);
    if (!replay || replay.action !== action) throw new GameStoreError("STATE_CONFLICT", "好友关系刚刚发生变化，请重试。", 409);
    return { player: await loadPublicPlayer(db, player), friendId: parseFriendAudit(replay.resultJson), replayed: true };
  }
  return { player: await loadPublicPlayer(db, player), friendId: friend.id, replayed: false };
}

/** Send a private message only after the two players have accepted each other. */
export async function sendChatMessage(
  identity: GameIdentity,
  input: { idempotencyKey: string; friendId: string; text: string },
): Promise<ChatMutationResult> {
  const db = getD1();
  await ensureSchema(db);
  const player = await ensurePlayer(db, identity);
  const friend = await getPlayerRow(db, input.friendId.trim());
  if (friend.id === player.id) throw new GameStoreError("CHAT_SELF_TARGET", "不能给自己发送聊天消息。", 400);
  await assertAcceptedFriend(db, player.id, friend.id);
  if (await isSocialBlocked(db, player.id, friend.id)) {
    throw new GameStoreError("CHAT_BLOCKED", "该玩家已被屏蔽，无法发送消息。", 403);
  }
  const text = normalizeChatText(input.text);
  const existingAudit = await findAudit(db, player.id, input.idempotencyKey);
  if (existingAudit) {
    if (existingAudit.action !== "send_chat") throw new GameStoreError("IDEMPOTENCY_KEY_REUSED", "该幂等键已经用于其他操作。", 409);
    const message = parseChatAudit(existingAudit.resultJson);
    return { player: await loadPublicPlayer(db, player), message, replayed: true };
  }
  const now = new Date().toISOString();
  const message: SocialMessage = {
    id: `chat-${(await stableId(`${player.id}|${input.idempotencyKey}`)).slice(0, 24)}`,
    senderId: player.id,
    recipientId: friend.id,
    text,
    createdAt: now,
  };
  const auditId = `audit-${(await stableId(`${player.id}|${input.idempotencyKey}`)).slice(0, 24)}`;
  const resultJson = JSON.stringify({ message });
  const results = await db.batch([
    db.prepare(
      `INSERT OR IGNORE INTO audit_events
         (id, player_id, action, idempotency_key, payload_json, result_json, created_at)
       VALUES (?, ?, 'send_chat', ?, ?, ?, ?)`,
    ).bind(auditId, player.id, input.idempotencyKey, JSON.stringify({ friendId: friend.id, text }), resultJson, now),
    db.prepare(
      `INSERT INTO social_messages (id, sender_id, recipient_id, body, created_at)
       SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM audit_events WHERE id = ?)`,
    ).bind(message.id, player.id, friend.id, text, now, auditId),
  ]);
  if ((results[0]?.meta?.changes ?? 0) === 0) {
    const replay = await findAudit(db, player.id, input.idempotencyKey);
    if (!replay || replay.action !== "send_chat") throw new GameStoreError("STATE_CONFLICT", "聊天记录刚刚发生变化，请重试。", 409);
    const replayMessage = parseChatAudit(replay.resultJson);
    return { player: await loadPublicPlayer(db, player), message: replayMessage, replayed: true };
  }
  return { player: await loadPublicPlayer(db, player), message, replayed: false };
}

export async function blockPlayer(
  identity: GameIdentity,
  input: { idempotencyKey: string; targetId: string },
): Promise<SocialActionResult> {
  return mutateSocialBlock(identity, input, "block");
}

export async function unblockPlayer(
  identity: GameIdentity,
  input: { idempotencyKey: string; targetId: string },
): Promise<SocialActionResult> {
  return mutateSocialBlock(identity, input, "unblock");
}

async function mutateSocialBlock(
  identity: GameIdentity,
  input: { idempotencyKey: string; targetId: string },
  operation: "block" | "unblock",
): Promise<SocialActionResult> {
  const db = getD1();
  await ensureSchema(db);
  const player = await ensurePlayer(db, identity);
  const target = await getPlayerRow(db, input.targetId.trim());
  if (target.id === player.id) throw new GameStoreError("SOCIAL_SELF_TARGET", "不能对自己执行社交操作。", 400);
  const action = `social_${operation}`;
  const existingAudit = await findAudit(db, player.id, input.idempotencyKey);
  if (existingAudit) {
    if (existingAudit.action !== action) throw new GameStoreError("IDEMPOTENCY_KEY_REUSED", "该幂等键已经用于其他操作。", 409);
    return { player: await loadPublicPlayer(db, player), targetId: parseSocialAudit(existingAudit.resultJson), replayed: true };
  }
  const currentlyBlocked = await isSocialBlocked(db, player.id, target.id);
  if (operation === "block" && currentlyBlocked) throw new GameStoreError("PLAYER_ALREADY_BLOCKED", "该玩家已经被屏蔽。", 409);
  if (operation === "unblock" && !currentlyBlocked) throw new GameStoreError("PLAYER_NOT_BLOCKED", "该玩家当前没有被屏蔽。", 409);
  const now = new Date().toISOString();
  const auditId = `audit-${(await stableId(`${player.id}|${input.idempotencyKey}`)).slice(0, 24)}`;
  const resultJson = JSON.stringify({ targetId: target.id });
  const statement = operation === "block"
    ? db.prepare(`INSERT INTO social_blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)`).bind(player.id, target.id, now)
    : db.prepare(`DELETE FROM social_blocks WHERE blocker_id = ? AND blocked_id = ?`).bind(player.id, target.id);
  const results = await db.batch([
    db.prepare(
      `INSERT OR IGNORE INTO audit_events
         (id, player_id, action, idempotency_key, payload_json, result_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(auditId, player.id, action, input.idempotencyKey, JSON.stringify({ targetId: target.id }), resultJson, now),
    statement,
  ]);
  if ((results[0]?.meta?.changes ?? 0) === 0) {
    const replay = await findAudit(db, player.id, input.idempotencyKey);
    if (!replay || replay.action !== action) throw new GameStoreError("STATE_CONFLICT", "屏蔽状态刚刚发生变化，请重试。", 409);
    return { player: await loadPublicPlayer(db, player), targetId: parseSocialAudit(replay.resultJson), replayed: true };
  }
  return { player: await loadPublicPlayer(db, player), targetId: target.id, replayed: false };
}

export async function reportPlayer(
  identity: GameIdentity,
  input: { idempotencyKey: string; targetId: string; reason: string },
): Promise<SocialActionResult> {
  const db = getD1();
  await ensureSchema(db);
  const player = await ensurePlayer(db, identity);
  const target = await getPlayerRow(db, input.targetId.trim());
  if (target.id === player.id) throw new GameStoreError("SOCIAL_SELF_TARGET", "不能举报自己。", 400);
  const reason = normalizeReportReason(input.reason);
  const existingAudit = await findAudit(db, player.id, input.idempotencyKey);
  if (existingAudit) {
    if (existingAudit.action !== "social_report") throw new GameStoreError("IDEMPOTENCY_KEY_REUSED", "该幂等键已经用于其他操作。", 409);
    return { player: await loadPublicPlayer(db, player), targetId: parseSocialAudit(existingAudit.resultJson), replayed: true };
  }
  const now = new Date().toISOString();
  const reportId = `report-${(await stableId(`${player.id}|${input.idempotencyKey}`)).slice(0, 24)}`;
  const auditId = `audit-${(await stableId(`${player.id}|${input.idempotencyKey}`)).slice(0, 24)}`;
  const resultJson = JSON.stringify({ targetId: target.id });
  const results = await db.batch([
    db.prepare(
      `INSERT OR IGNORE INTO audit_events
         (id, player_id, action, idempotency_key, payload_json, result_json, created_at)
       VALUES (?, ?, 'social_report', ?, ?, ?, ?)`,
    ).bind(auditId, player.id, input.idempotencyKey, JSON.stringify({ targetId: target.id, reason }), resultJson, now),
    db.prepare(
      `INSERT INTO social_reports (id, reporter_id, target_id, reason, created_at)
       SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM audit_events WHERE id = ?)`,
    ).bind(reportId, player.id, target.id, reason, now, auditId),
  ]);
  if ((results[0]?.meta?.changes ?? 0) === 0) {
    const replay = await findAudit(db, player.id, input.idempotencyKey);
    if (!replay || replay.action !== "social_report") throw new GameStoreError("STATE_CONFLICT", "举报记录刚刚发生变化，请重试。", 409);
    return { player: await loadPublicPlayer(db, player), targetId: parseSocialAudit(replay.resultJson), replayed: true };
  }
  return { player: await loadPublicPlayer(db, player), targetId: target.id, replayed: false };
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

export async function craftCard(
  identity: GameIdentity,
  input: { idempotencyKey: string; cardId: string },
): Promise<CardEconomyResult> {
  const db = getD1();
  await ensureSchema(db);
  const player = await ensurePlayer(db, identity);
  const card = CARD_CATALOG.find((candidate) => candidate.id === input.cardId);
  if (!card) throw new GameStoreError("CARD_NOT_FOUND", "卡牌不存在。", 404);
  const cost = craftCost(card.rarity);
  return commitMutation(
    db,
    player,
    "craft_card",
    input.idempotencyKey,
    { cardId: input.cardId, costDust: cost },
    (current) => {
      if (current.currencies.dust < cost) {
        throw new GameStoreError("INSUFFICIENT_DUST", "星尘不足，无法制作这张卡。", 409);
      }
      return {
        nextState: {
          ...current,
          currencies: { ...current.currencies, dust: current.currencies.dust - cost },
          collection: {
            ...current.collection,
            [input.cardId]: (current.collection[input.cardId] ?? 0) + 1,
          },
        },
        result: { cardId: input.cardId, amount: cost, kind: "craft" as const },
      };
    },
  ).then(({ player: nextPlayer, result, replayed }) => ({
    player: nextPlayer,
    cardId: result.cardId,
    amount: result.amount,
    kind: result.kind,
    replayed,
  }));
}

export async function disenchantCard(
  identity: GameIdentity,
  input: { idempotencyKey: string; cardId: string },
): Promise<CardEconomyResult> {
  const db = getD1();
  await ensureSchema(db);
  const player = await ensurePlayer(db, identity);
  const card = CARD_CATALOG.find((candidate) => candidate.id === input.cardId);
  if (!card) throw new GameStoreError("CARD_NOT_FOUND", "卡牌不存在。", 404);
  const value = disenchantValue(card.rarity);
  return commitMutation(
    db,
    player,
    "disenchant_card",
    input.idempotencyKey,
    { cardId: input.cardId, dust: value },
    (current) => {
      const owned = current.collection[input.cardId] ?? 0;
      const deckUse = current.decks.reduce(
        (count, deck) => count + deck.cardIds.filter((cardId) => cardId === input.cardId).length,
        0,
      );
      if (owned < 1 || owned <= deckUse) {
        throw new GameStoreError("CARD_IN_USE", "卡牌正在卡组中使用，至少保留卡组所需数量。", 409);
      }
      return {
        nextState: {
          ...current,
          currencies: { ...current.currencies, dust: current.currencies.dust + value },
          collection: { ...current.collection, [input.cardId]: owned - 1 },
        },
        result: { cardId: input.cardId, amount: value, kind: "disenchant" as const },
      };
    },
  ).then(({ player: nextPlayer, result, replayed }) => ({
    player: nextPlayer,
    cardId: result.cardId,
    amount: result.amount,
    kind: result.kind,
    replayed,
  }));
}

export async function claimReward(
  identity: GameIdentity,
  input: { idempotencyKey: string; level: number },
): Promise<ClaimRewardResult> {
  const db = getD1();
  await ensureSchema(db);
  const player = await ensurePlayer(db, identity);
  const reward = REWARD_TRACK.find((candidate) => candidate.level === input.level);
  if (!reward) throw new GameStoreError("REWARD_NOT_FOUND", "奖励等级不存在。", 404);
  return commitMutation(
    db,
    player,
    "claim_reward",
    input.idempotencyKey,
    { level: input.level },
    (current) => {
      if (current.progression.level < reward.level) {
        throw new GameStoreError("REWARD_LOCKED", "奖励等级尚未解锁。", 409);
      }
      if (current.rewardTrack.claimedLevels.includes(reward.level)) {
        throw new GameStoreError("REWARD_ALREADY_CLAIMED", "该奖励已经领取。", 409);
      }
      const claimedLevels = [...current.rewardTrack.claimedLevels, reward.level].sort((a, b) => a - b);
      const nextState = {
        ...current,
        rewardTrack: { claimedLevels },
        currencies: {
          ...current.currencies,
          gold: current.currencies.gold + (reward.kind === "gold" ? reward.amount : 0),
          dust: current.currencies.dust + (reward.kind === "dust" ? reward.amount : 0),
        },
        packsAvailable: current.packsAvailable + (reward.kind === "pack" ? reward.amount : 0),
      };
      return {
        nextState,
        result: { level: reward.level, reward: { title: reward.title, kind: reward.kind, amount: reward.amount } },
      };
    },
  ).then(({ player: nextPlayer, result, replayed }) => ({
    player: nextPlayer,
    level: result.level,
    reward: result.reward,
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
    format?: MatchFormat;
    aiProof?: AiMatchProof;
  },
): Promise<RecordMatchResult> {
  const db = getD1();
  await ensureSchema(db);
  const player = await ensurePlayer(db, identity);
  let verifiedFormat: MatchFormat = "ranked";
  if (input.mode === "pvp") {
    if (!input.pvpToken || input.pvpPlayer === undefined) {
      throw new GameStoreError("PVP_PROOF_REQUIRED", "联机对局缺少服务器凭证。", 400);
    }
    const row = await db
      .prepare("SELECT match_token AS matchToken, state_json AS stateJson, format FROM pvp_matches WHERE match_token = ?")
      .bind(input.pvpToken)
      .first<PvpMatchRow>();
    if (!row) {
      throw new GameStoreError("PVP_PROOF_INVALID", "联机对局凭证无效或已过期。", 409);
    }
    verifiedFormat = row.format === "casual" ? "casual" : "ranked";
    if (input.format !== undefined && input.format !== verifiedFormat) {
      throw new GameStoreError("PVP_FORMAT_MISMATCH", "对战模式与服务器房间不一致。", 409);
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
  if (input.mode === "ai" && !input.aiProof) {
    throw new GameStoreError("AI_PROOF_REQUIRED", "AI 对局缺少服务端重放凭证。", 400);
  }
  const matchId = `match-${(await stableId(`${player.id}|${input.idempotencyKey}`)).slice(0, 20)}`;
  const matchCreatedAt = new Date().toISOString();

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
      ...(input.format ? { format: input.format } : {}),
      ...(input.aiProof ? { aiProof: input.aiProof } : {}),
    },
    (current) => {
      if (input.mode === "ai") {
        const verifiedResult = verifyAiMatchProof(current, input.aiProof as AiMatchProof);
        if (verifiedResult !== input.result) {
          throw new GameStoreError("AI_RESULT_MISMATCH", "对局结果与服务端重放结果不一致。", 409);
        }
      }
      const aiRewardEligible = input.mode !== "ai" || current.taskCycle.aiRewardsToday < DAILY_AI_REWARD_LIMIT;
      const rewardGold = aiRewardEligible
        ? input.result === "win" ? WIN_REWARD_GOLD : LOSS_REWARD_GOLD
        : 0;
      const matchFormat: MatchFormat | undefined = input.mode === "pvp"
        ? (input.format ?? verifiedFormat)
        : undefined;
      const match: MatchRecord = {
        id: matchId,
        result: input.result,
        mode: input.mode,
        ...(matchFormat ? { format: matchFormat } : {}),
        opponent: input.opponent,
        rewardGold,
        ...(input.pvpToken ? { pvpToken: input.pvpToken } : {}),
        createdAt: matchCreatedAt,
      };
      const nextState: StoredPlayerState = {
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
        progression: aiRewardEligible ? awardXp(current.progression, MATCH_REWARD_XP) : current.progression,
        taskCycle: {
          ...current.taskCycle,
          aiRewardsToday: input.mode === "ai"
            ? Math.min(DAILY_AI_REWARD_LIMIT, current.taskCycle.aiRewardsToday + 1)
            : current.taskCycle.aiRewardsToday,
        },
        ladder: input.mode === "pvp" && matchFormat === "ranked" ? updateLadder(current.ladder, input.result) : current.ladder,
      };
      return {
        nextState,
        result: { match },
        match,
      };
    },
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
               (id, player_id, idempotency_key, pvp_token, result, mode, opponent, reward_gold, format, created_at)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
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
            match.format ?? null,
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
    // Backfill legacy email-based rows on first access. The platform identity
    // may change its auth display name, but a player-chosen public name must
    // survive refreshes; profile changes go through updateProfile instead.
    await db
      .prepare(
        `UPDATE players
         SET email = ?, identity_key = ?, updated_at = ?
         WHERE id = ?`,
      )
      .bind(normalizedEmail, identityKey, now, existing.id)
      .run();
    return { ...existing, email: normalizedEmail };
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

async function getPlayerRow(db: D1DatabaseLike, playerId: string): Promise<PlayerRow> {
  const row = await db
    .prepare(
      `SELECT id, email, display_name AS displayName
       FROM players
       WHERE id = ?
       LIMIT 1`,
    )
    .bind(playerId)
    .first<PlayerRow>();
  if (!row) throw new GameStoreError("PLAYER_NOT_FOUND", "玩家档案不存在。", 404);
  return row;
}

async function getFriendLink(db: D1DatabaseLike, playerA: string, playerB: string): Promise<FriendLinkRow | null> {
  return db
    .prepare(
      `SELECT id, player_a AS playerA, player_b AS playerB, status, requested_by AS requestedBy
       FROM friend_links
       WHERE player_a = ? AND player_b = ?
       LIMIT 1`,
    )
    .bind(playerA, playerB)
    .first<FriendLinkRow>();
}

async function assertAcceptedFriend(db: D1DatabaseLike, playerId: string, friendId: string): Promise<void> {
  const [playerA, playerB] = [playerId, friendId].sort();
  const link = await getFriendLink(db, playerA, playerB);
  if (!link || link.status !== "accepted") {
    throw new GameStoreError("CHAT_FRIEND_REQUIRED", "只有已互相接受的好友才能聊天。", 403);
  }
}

async function isSocialBlocked(db: D1DatabaseLike, blockerId: string, blockedId: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS blocked
       FROM social_blocks
       WHERE (blocker_id = ? AND blocked_id = ?)
          OR (blocker_id = ? AND blocked_id = ?)
       LIMIT 1`,
    )
    .bind(blockerId, blockedId, blockedId, blockerId)
    .first<{ blocked: number }>();
  return Boolean(row);
}

function normalizeDisplayName(value: string): string {
  const displayName = value.trim().replace(/\s+/g, " ");
  if (displayName.length < 1 || displayName.length > 24 || /[\u0000-\u001f\u007f]/.test(displayName)) {
    throw new GameStoreError("INVALID_DISPLAY_NAME", "公开昵称必须为 1–24 个字符。", 400);
  }
  return displayName;
}

function parseProfileAudit(resultJson: string): { displayName: string } {
  try {
    const parsed = JSON.parse(resultJson) as { displayName?: unknown };
    if (typeof parsed.displayName !== "string") throw new Error("invalid");
    return { displayName: parsed.displayName };
  } catch {
    throw new GameStoreError("CORRUPT_AUDIT_EVENT", "无法读取已完成的档案操作。", 500);
  }
}

function parseFriendAudit(resultJson: string): string {
  try {
    const parsed = JSON.parse(resultJson) as { friendId?: unknown };
    if (typeof parsed.friendId !== "string") throw new Error("invalid");
    return parsed.friendId;
  } catch {
    throw new GameStoreError("CORRUPT_AUDIT_EVENT", "无法读取已完成的好友操作。", 500);
  }
}

function parseSocialAudit(resultJson: string): string {
  try {
    const parsed = JSON.parse(resultJson) as { targetId?: unknown };
    if (typeof parsed.targetId !== "string") throw new Error("invalid");
    return parsed.targetId;
  } catch {
    throw new GameStoreError("CORRUPT_AUDIT_EVENT", "无法读取已完成的社交操作。", 500);
  }
}

function parseChatAudit(resultJson: string): SocialMessage {
  try {
    const parsed = JSON.parse(resultJson) as { message?: SocialMessage };
    if (!parsed.message || typeof parsed.message.id !== "string" || typeof parsed.message.text !== "string") throw new Error("invalid");
    return parsed.message;
  } catch {
    throw new GameStoreError("CORRUPT_AUDIT_EVENT", "无法读取已完成的聊天操作。", 500);
  }
}

function normalizeChatText(value: string): string {
  const text = value.trim().replace(/\s+/g, " ");
  if (text.length < 1 || text.length > 240 || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new GameStoreError("INVALID_CHAT_TEXT", "聊天消息必须为 1–240 个字符。", 400);
  }
  return text;
}

function normalizeReportReason(value: string): string {
  const reason = value.trim().replace(/\s+/g, " ");
  if (reason.length < 2 || reason.length > 200 || /[\u0000-\u001f\u007f]/.test(reason)) {
    throw new GameStoreError("INVALID_REPORT_REASON", "举报原因必须为 2–200 个字符。", 400);
  }
  return reason;
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
              format,
              created_at AS createdAt
       FROM match_records
       WHERE player_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT 20`,
    )
    .bind(player.id)
    .all<MatchRow>();
  const friendResult = await db
    .prepare(
      `SELECT fl.status,
              fl.requested_by AS requestedBy,
              CASE WHEN fl.player_a = ? THEN fl.player_b ELSE fl.player_a END AS friendId,
              p.display_name AS displayName
       FROM friend_links fl
       JOIN players p ON p.id = CASE WHEN fl.player_a = ? THEN fl.player_b ELSE fl.player_a END
       WHERE (fl.player_a = ? OR fl.player_b = ?)
       ORDER BY fl.updated_at DESC, fl.id DESC
       LIMIT 100`,
    )
    .bind(player.id, player.id, player.id, player.id)
    .all<{ status: "pending" | "accepted"; requestedBy: string; friendId: string; displayName: string }>();
  const chatResult = await db
    .prepare(
      `SELECT id, sender_id AS senderId, recipient_id AS recipientId,
              body AS text, created_at AS createdAt
       FROM social_messages
       WHERE sender_id = ? OR recipient_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT 100`,
    )
    .bind(player.id, player.id)
    .all<SocialMessageRow>();
  const blockedResult = await db
    .prepare(
      `SELECT blocked_id AS blockedId
       FROM social_blocks
       WHERE blocker_id = ?
       ORDER BY created_at DESC
       LIMIT 100`,
    )
    .bind(player.id)
    .all<{ blockedId: string }>();

  return {
    id: player.id,
    email: player.email,
    displayName: player.displayName,
    ...cloneState(stored),
    friends: friendResult.results.map((friend) => ({
      id: friend.friendId,
      displayName: friend.displayName,
      status: friend.status,
      direction: friend.status === "accepted" || friend.requestedBy === player.id ? "outgoing" : "incoming",
    })),
    chatMessages: chatResult.results.map((message) => ({
      id: message.id,
      senderId: message.senderId,
      recipientId: message.recipientId,
      text: message.text,
      createdAt: message.createdAt,
    })),
    blockedPlayerIds: blockedResult.results.map((row) => row.blockedId),
    recentMatches: matchResult.results.map((match) => {
      const safeMatch: MatchRecord = {
        id: match.id,
        result: match.result,
        mode: match.mode,
        opponent: match.opponent,
        rewardGold: match.rewardGold,
        createdAt: match.createdAt,
        format: match.format === "casual" ? "casual" : "ranked",
      };
      delete safeMatch.pvpToken;
      return safeMatch;
    }),
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
        format TEXT NOT NULL DEFAULT 'ranked' CHECK (format IN ('ranked', 'casual')),
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
    // Social graph: one canonical row per pair keeps friend requests,
    // accepts and retries deterministic across devices.
    db.prepare(
      `CREATE TABLE IF NOT EXISTS friend_links (
        id TEXT PRIMARY KEY NOT NULL,
        player_a TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        player_b TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('pending', 'accepted')),
        requested_by TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(player_a, player_b)
      )`,
    ),
    db.prepare(
      `CREATE INDEX IF NOT EXISTS friend_links_player_a_idx ON friend_links (player_a, status)`,
    ),
    db.prepare(
      `CREATE INDEX IF NOT EXISTS friend_links_player_b_idx ON friend_links (player_b, status)`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS social_messages (
        id TEXT PRIMARY KEY NOT NULL,
        sender_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        recipient_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
    ),
    db.prepare(
      `CREATE INDEX IF NOT EXISTS social_messages_pair_idx
       ON social_messages (sender_id, recipient_id, created_at)`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS social_blocks (
        blocker_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        blocked_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (blocker_id, blocked_id)
      )`,
    ),
    db.prepare(
      `CREATE INDEX IF NOT EXISTS social_blocks_blocked_idx ON social_blocks (blocked_id)`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS social_reports (
        id TEXT PRIMARY KEY NOT NULL,
        reporter_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        target_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
    ),
    db.prepare(
      `CREATE INDEX IF NOT EXISTS social_reports_created_idx ON social_reports (created_at)`,
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
  try {
    await db.prepare("ALTER TABLE match_records ADD COLUMN format TEXT NOT NULL DEFAULT 'ranked'").run();
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
    packPity: { packsOpened: 0, packsSinceLegendary: 0 },
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
      aiRewardsToday: 0,
      weeklyFreePackClaimed: false,
    },
    progression: { xp: 0, level: 1 },
    rewardTrack: { claimedLevels: [] },
    ladder: { seasonKey: utcSeasonKey(now), rating: 1000, tier: "青铜", stars: 0, wins: 0, losses: 0, highestRating: 1000 },
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
        aiRewardsToday: isFiniteNonNegativeInteger(value.taskCycle.aiRewardsToday)
          ? Math.min(value.taskCycle.aiRewardsToday, DAILY_AI_REWARD_LIMIT)
          : 0,
        weeklyFreePackClaimed: value.taskCycle.weeklyFreePackClaimed === true,
      }
    : { dayKey: "", weekKey: "", dailyRerollsRemaining: DAILY_REROLL_LIMIT, packsBoughtToday: 0, aiRewardsToday: 0, weeklyFreePackClaimed: false };
  const packPity = isRecord(value.packPity)
    ? {
        packsOpened: isFiniteNonNegativeInteger(value.packPity.packsOpened) ? value.packPity.packsOpened : 0,
        packsSinceLegendary: isFiniteNonNegativeInteger(value.packPity.packsSinceLegendary)
          ? Math.min(value.packPity.packsSinceLegendary, LEGENDARY_PITY_LIMIT - 1)
          : 0,
      }
    : { packsOpened: 0, packsSinceLegendary: 0 };
  const legacyMatches = isRecord(value.stats) && isFiniteNonNegativeInteger(value.stats.matchesPlayed)
    ? value.stats.matchesPlayed
    : 0;
  const hasRewardTrack = isRecord(value.rewardTrack) && Array.isArray(value.rewardTrack.claimedLevels);
  const storedXp = isRecord(value.progression) && isFiniteNonNegativeInteger(value.progression.xp)
    ? value.progression.xp
    : 0;
  // Accounts created before the progression system stored match totals but no XP.
  // Backfill those accounts once, while preserving a deliberately reset 0-XP account
  // after the new reward-track state has been persisted.
  const shouldBackfillXp = legacyMatches > 0 && !hasRewardTrack && storedXp === 0;
  const progressionXp = shouldBackfillXp ? legacyMatches * MATCH_REWARD_XP : storedXp;
  const progression = {
    xp: progressionXp,
    level: isRecord(value.progression) && !shouldBackfillXp && isFiniteNonNegativeInteger(value.progression.level) && value.progression.level > 0
      ? value.progression.level
      : Math.floor(progressionXp / 1000) + 1,
  };
  const rewardTrack = isRecord(value.rewardTrack) && Array.isArray(value.rewardTrack.claimedLevels)
    ? { claimedLevels: value.rewardTrack.claimedLevels.filter(isFiniteNonNegativeInteger) }
    : { claimedLevels: [] };
  const ladder = isRecord(value.ladder)
    ? {
        seasonKey: typeof value.ladder.seasonKey === "string" ? value.ladder.seasonKey : utcSeasonKey(new Date().toISOString()),
        rating: isFiniteNonNegativeInteger(value.ladder.rating) ? value.ladder.rating : 1000,
        tier: typeof value.ladder.tier === "string" ? value.ladder.tier : "青铜",
        stars: isFiniteNonNegativeInteger(value.ladder.stars) ? value.ladder.stars : 0,
        wins: isFiniteNonNegativeInteger(value.ladder.wins) ? value.ladder.wins : 0,
        losses: isFiniteNonNegativeInteger(value.ladder.losses) ? value.ladder.losses : 0,
        highestRating: isFiniteNonNegativeInteger(value.ladder.highestRating)
          ? value.ladder.highestRating
          : (isFiniteNonNegativeInteger(value.ladder.rating) ? value.ladder.rating : 1000),
      }
    : { seasonKey: utcSeasonKey(new Date().toISOString()), rating: 1000, tier: "青铜", stars: 0, wins: 0, losses: 0, highestRating: 1000 };
  return { ...value, tasks, taskCycle, packPity, progression, rewardTrack, ladder } as StoredPlayerState;
}

function isStoredState(value: unknown): value is StoredPlayerState {
  if (!isRecord(value)) return false;
  if (
    !isRecord(value.currencies) ||
    !isFiniteNonNegativeInteger(value.currencies.gold) ||
    !isFiniteNonNegativeInteger(value.currencies.dust) ||
    !isFiniteNonNegativeInteger(value.packsAvailable) ||
    !isPackPity(value.packPity) ||
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
    isRewardTrack(value.rewardTrack) &&
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
    isFiniteNonNegativeInteger(value.packsBoughtToday) &&
    isFiniteNonNegativeInteger(value.aiRewardsToday) &&
    typeof value.weeklyFreePackClaimed === "boolean" &&
    value.aiRewardsToday <= DAILY_AI_REWARD_LIMIT
  );
}

function isPackPity(value: unknown): value is PackPityState {
  return isRecord(value)
    && isFiniteNonNegativeInteger(value.packsOpened)
    && isFiniteNonNegativeInteger(value.packsSinceLegendary)
    && value.packsSinceLegendary < LEGENDARY_PITY_LIMIT;
}

function isProgression(value: unknown): value is PlayerProgression {
  return isRecord(value) && isFiniteNonNegativeInteger(value.xp) && isFiniteNonNegativeInteger(value.level) && value.level > 0;
}

function isRewardTrack(value: unknown): value is RewardTrackState {
  return isRecord(value) && Array.isArray(value.claimedLevels) && value.claimedLevels.every(isFiniteNonNegativeInteger);
}

function isLadder(value: unknown): value is PlayerLadder {
  return (
    isRecord(value) &&
    typeof value.seasonKey === "string" &&
    isFiniteNonNegativeInteger(value.rating) &&
    typeof value.tier === "string" &&
    isFiniteNonNegativeInteger(value.stars) &&
    isFiniteNonNegativeInteger(value.wins) &&
    isFiniteNonNegativeInteger(value.losses) &&
    isFiniteNonNegativeInteger(value.highestRating)
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
    packPity: { ...state.packPity },
    collection: { ...state.collection },
    decks: state.decks.map(cloneDeck),
    activeDeckId: state.activeDeckId,
    tasks: state.tasks.map(cloneTask),
    taskCycle: { ...state.taskCycle },
    progression: { ...state.progression },
    rewardTrack: { claimedLevels: [...state.rewardTrack.claimedLevels] },
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
    state.packPity.packsOpened === 0 &&
    state.packPity.packsSinceLegendary === 0 &&
    collectionKeys.length === starter.size &&
    collectionKeys.every((cardId) => state.collection[cardId] === starter.get(cardId)) &&
    state.decks.length === 1 &&
    state.decks[0]?.id === "starter-sun" &&
    state.stats.wins === 0 &&
    state.stats.losses === 0 &&
    state.stats.matchesPlayed === 0 &&
    state.progression.xp === 0 &&
    state.rewardTrack.claimedLevels.length === 0 &&
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
    seasonKey: ladder.seasonKey,
    rating,
    tier,
    stars: Math.floor((rating % 200) / 50),
    wins: ladder.wins + (result === "win" ? 1 : 0),
    losses: ladder.losses + (result === "loss" ? 1 : 0),
    highestRating: Math.max(ladder.highestRating, rating),
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
  const seasonKey = utcSeasonKey(now);
  const firstLoad = !state.taskCycle.dayKey || !state.taskCycle.weekKey;
  const dayChanged = !firstLoad && state.taskCycle.dayKey !== dayKey;
  const weekChanged = !firstLoad && state.taskCycle.weekKey !== weekKey;
  const seasonChanged = state.ladder.seasonKey !== seasonKey;
  if (!dayChanged && !weekChanged && !seasonChanged && !firstLoad) return state;

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
      aiRewardsToday: dayChanged || firstLoad ? 0 : state.taskCycle.aiRewardsToday,
      weeklyFreePackClaimed: weekChanged || firstLoad ? false : state.taskCycle.weeklyFreePackClaimed,
    },
    ladder: seasonChanged || firstLoad
      ? { ...state.ladder, seasonKey, rating: 1000, tier: "青铜", stars: 0, wins: 0, losses: 0 }
      : state.ladder,
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

function utcSeasonKey(value: string): string {
  return value.slice(0, 7);
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

function verifyAiMatchProof(
  current: StoredPlayerState,
  proof: AiMatchProof,
): MatchResult {
  if (
    !Number.isSafeInteger(proof.seed) ||
    proof.seed < 0 ||
    !Array.isArray(proof.playerDeck) ||
    proof.playerDeck.length !== 30 ||
    !Array.isArray(proof.commands) ||
    proof.commands.length === 0 ||
    proof.commands.length > 400 ||
    (proof.startingPlayer !== 0 && proof.startingPlayer !== 1)
  ) {
    throw new GameStoreError("AI_PROOF_INVALID", "AI 对局重放凭证格式无效。", 409);
  }
  const archetype = AI_ARCHETYPES.find((candidate) => candidate.id === proof.opponentArchetypeId);
  if (!archetype) {
    throw new GameStoreError("AI_PROOF_INVALID", "AI 对手原型不存在。", 409);
  }
  const deckValidation = validateDeck(proof.playerDeck);
  if (!deckValidation.valid) {
    throw new GameStoreError("AI_PROOF_INVALID", "AI 对局使用了无效玩家卡组。", 409, deckValidation.errors);
  }
  assertCardsOwned(proof.playerDeck, current.collection);
  const savedDeckMatches = current.decks.some(
    (deck) => deck.cardIds.length === proof.playerDeck.length && deck.cardIds.every((cardId, index) => cardId === proof.playerDeck[index]),
  );
  if (!savedDeckMatches) {
    throw new GameStoreError("AI_PROOF_INVALID", "AI 对局卡组不是当前账号已保存卡组。", 409);
  }

  let state = createMatch({
    seed: proof.seed,
    startingPlayer: proof.startingPlayer,
    decks: [proof.playerDeck, [...archetype.deck]],
  });
  const commandIds = new Set<string>();
  for (const command of proof.commands) {
    if (!isRecord(command) || (typeof command.commandId === "string" && commandIds.has(command.commandId))) {
      throw new GameStoreError("AI_PROOF_INVALID", "AI 对局命令序列包含重复或无效命令。", 409);
    }
    if (typeof command.commandId === "string") commandIds.add(command.commandId);
    const result = applyCommand(state, command);
    if (!result.accepted) {
      throw new GameStoreError("AI_PROOF_INVALID", "AI 对局命令无法通过服务端规则重放。", 409, result.error);
    }
    state = result.state;
  }
  if (state.phase !== "game-over" || state.result?.winner === null || state.result?.winner === undefined) {
    throw new GameStoreError("AI_PROOF_INCOMPLETE", "AI 对局尚未完成，不能结算奖励。", 409);
  }
  return state.result.winner === 0 ? "win" : "loss";
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
