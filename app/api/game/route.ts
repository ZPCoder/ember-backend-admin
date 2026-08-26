import { getChatGPTUser } from "../../chatgpt-auth";
import {
  claimApprenticeReward,
  claimLadderReadyDeck,
  claimCatchUpPack,
  claimReturnQuest,
  claimTask,
  claimReward,
  claimWeeklyPack,
  createAiMatch,
  completeTrainingChapter,
  activateLadderReady,
  acceptFriendRequest,
  blockPlayer,
  buyPack,
  craftCard,
  deleteDeck,
  disenchantCard,
  disenchantExtraCards,
  GameStoreError,
  getPlayerState,
  linkAnonymousAccount,
  openPack,
  openPacks,
  recordMatch,
  rerollTask,
  resetDemoPlayer,
  reportPlayer,
  saveDeck,
  sendChatMessage,
  sendFriendRequest,
  unblockPlayer,
  updateProfile,
  MAX_AI_PROOF_COMMANDS,
  type GameIdentity,
  type AiMatchProof,
  type MatchMode,
  type MatchFormat,
  type MatchResult,
} from "../../../db/game-store";
import {
  APPRENTICE_MILESTONES,
  LADDER_READY_DECKS,
  type ApprenticeMilestoneId,
  type LadderReadyDeckId,
  type RankedFormat,
  type ReturnQuestStageId,
  getTrainingChapter,
  isPackType,
  type PackType,
  type CardQuality,
  type TrainingChapterId,
} from "../../../lib/game";

export const dynamic = "force-dynamic";

// AI match settlement carries the bounded command transcript used for
// authoritative replay. 512 KiB accommodates the maximum legal transcript
// while still placing a strict ceiling on request parsing work.
const MAX_BODY_BYTES = 512 * 1024;
const DEMO_IDENTITY: GameIdentity = {
  email: "demo@local.invalid",
  displayName: "本地演示玩家",
  isDemo: true,
  isAnonymous: false,
  identityKey: "demo",
};

const ANONYMOUS_COOKIE = "ember-device-id";
const ANONYMOUS_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

type GameAction =
  | {
      action: "create_ai_match";
      deckId?: string;
      ladderReadyDeckId?: LadderReadyDeckId;
      opponentArchetypeId: string;
      training?: boolean;
      trainingChapterId?: TrainingChapterId;
    }
  | {
      action: "activate_ladder_ready";
      idempotencyKey: string;
    }
  | {
      action: "claim_ladder_ready_deck";
      idempotencyKey: string;
      deckId: LadderReadyDeckId;
    }
  | {
      action: "claim_catch_up_pack";
      idempotencyKey: string;
    }
  | {
      action: "claim_return_quest";
      idempotencyKey: string;
      stageId: ReturnQuestStageId;
    }
  | {
      action: "save_deck";
      idempotencyKey: string;
      deck: {
        id?: string;
        name: string;
        format: RankedFormat;
        cardIds: string[];
      };
    }
  | {
      action: "delete_deck";
      idempotencyKey: string;
      deckId: string;
    }
  | {
      action: "claim_task";
      idempotencyKey: string;
      taskId: string;
    }
  | {
      action: "open_pack";
      idempotencyKey: string;
      packType?: PackType;
      quality?: CardQuality;
    }
  | {
      action: "open_packs";
      idempotencyKey: string;
      count: number;
      packType?: PackType;
      quality?: CardQuality;
    }
  | {
      action: "claim_weekly_pack";
      idempotencyKey: string;
    }
  | {
      action: "buy_pack";
      idempotencyKey: string;
      packType?: PackType;
      quality?: CardQuality;
    }
  | {
      action: "reroll_task";
      idempotencyKey: string;
      taskId: string;
    }
  | {
      action: "craft_card" | "disenchant_card";
      idempotencyKey: string;
      cardId: string;
      quality?: CardQuality;
    }
  | {
      action: "disenchant_extras";
      idempotencyKey: string;
    }
  | {
      action: "claim_reward";
      idempotencyKey: string;
      level: number;
    }
  | {
      action: "claim_apprentice_reward";
      idempotencyKey: string;
      milestoneId: ApprenticeMilestoneId;
    }
  | {
      action: "complete_training_chapter";
      idempotencyKey: string;
      chapterId: TrainingChapterId;
      aiProof: AiMatchProof;
    }
  | {
      action: "record_match";
      idempotencyKey: string;
      result: MatchResult;
      mode: MatchMode;
      opponent: string;
      pvpToken?: string;
      pvpPlayer?: 0 | 1;
      format?: MatchFormat;
      rankedFormat?: RankedFormat;
      aiProof?: AiMatchProof;
    }
  | {
      action: "reset_demo";
    }
  | {
      action: "link_device";
    }
  | {
      action: "update_profile";
      idempotencyKey: string;
      displayName: string;
    }
  | {
      action: "send_friend_request" | "accept_friend_request";
      idempotencyKey: string;
      friendId: string;
    }
  | {
      action: "send_chat";
      idempotencyKey: string;
      friendId: string;
      text: string;
    }
  | {
      action: "block_player" | "unblock_player";
      idempotencyKey: string;
      targetId: string;
    }
  | {
      action: "report_player";
      idempotencyKey: string;
      targetId: string;
      reason: string;
    };

class PayloadError extends Error {
  readonly code = "INVALID_PAYLOAD";
}

export async function GET(request: Request): Promise<Response> {
  try {
    const resolved = await resolveIdentity(request);
    if (!resolved) return unauthorized();

    const player = await getPlayerState(resolved.identity);
    return json({
      ok: true,
      identity: {
        email: resolved.identity.email,
        displayName: resolved.identity.displayName,
        isDemo: resolved.identity.isDemo,
        isAnonymous: resolved.identity.isAnonymous,
        canLinkDevice: Boolean(resolved.anonymousIdentity),
      },
      player,
    }, 200, resolved.setCookie);
  } catch (error) {
    return handleError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const resolved = await resolveIdentity(request);
    if (!resolved) return unauthorized();
    const identity = resolved.identity;

    const action = parseAction(await readJsonBody(request));
    switch (action.action) {
      case "create_ai_match": {
        const result = await createAiMatch(identity, action);
        return json({
          ok: true,
          action: action.action,
          player: result.player,
          aiMatch: result.aiMatch,
          replayed: result.replayed,
        }, 200, resolved.setCookie);
      }
      case "complete_training_chapter": {
        const result = await completeTrainingChapter(identity, action);
        return json({
          ok: true,
          action: action.action,
          player: result.player,
          trainingChapterId: result.chapterId,
          replayed: result.replayed,
        }, 200, resolved.setCookie);
      }
      case "activate_ladder_ready": {
        const result = await activateLadderReady(identity, action);
        return json({
          ok: true,
          action: action.action,
          player: result.player,
          replayed: result.replayed,
        }, 200, resolved.setCookie);
      }
      case "claim_ladder_ready_deck": {
        const result = await claimLadderReadyDeck(identity, action);
        return json({
          ok: true,
          action: action.action,
          player: result.player,
          claimedLadderReadyDeck: result.claimedLadderReadyDeck,
          replayed: result.replayed,
        }, 200, resolved.setCookie);
      }
      case "claim_catch_up_pack": {
        const result = await claimCatchUpPack(identity, action);
        return json({
          ok: true,
          action: action.action,
          player: result.player,
          openedCards: result.openedCards,
          replayed: result.replayed,
        }, 200, resolved.setCookie);
      }
      case "claim_return_quest": {
        const result = await claimReturnQuest(identity, action);
        return json({
          ok: true,
          action: action.action,
          player: result.player,
          stageId: result.stageId,
          openedCards: result.openedCards,
          replayed: result.replayed,
        }, 200, resolved.setCookie);
      }
      case "save_deck": {
        const result = await saveDeck(identity, action);
        return json({
          ok: true,
          action: action.action,
          player: result.player,
          savedDeck: result.savedDeck,
          replayed: result.replayed,
        }, 200, resolved.setCookie);
      }
      case "delete_deck": {
        const result = await deleteDeck(identity, action);
        return json({
          ok: true,
          action: action.action,
          player: result.player,
          deletedDeckId: result.deletedDeckId,
          replayed: result.replayed,
        }, 200, resolved.setCookie);
      }
      case "claim_task": {
        const result = await claimTask(identity, action);
        return json({
          ok: true,
          action: action.action,
          player: result.player,
          claimedTaskId: result.claimedTaskId,
          rewardGold: result.rewardGold,
          replayed: result.replayed,
        }, 200, resolved.setCookie);
      }
      case "open_pack": {
        const result = await openPack(identity, action);
        return json({
          ok: true,
          action: action.action,
          player: result.player,
          openedCards: result.openedCards,
          packsOpened: result.packsOpened,
          packType: result.packType,
          quality: result.quality,
          replayed: result.replayed,
        }, 200, resolved.setCookie);
      }
      case "open_packs": {
        const result = await openPacks(identity, action);
        return json({
          ok: true,
          action: action.action,
          player: result.player,
          openedCards: result.openedCards,
          packsOpened: result.packsOpened,
          packType: result.packType,
          quality: result.quality,
          replayed: result.replayed,
        }, 200, resolved.setCookie);
      }
      case "claim_weekly_pack": {
        const result = await claimWeeklyPack(identity, action);
        return json({
          ok: true,
          action: action.action,
          player: result.player,
          replayed: result.replayed,
        }, 200, resolved.setCookie);
      }
      case "buy_pack": {
        const result = await buyPack(identity, action);
        return json({
          ok: true,
          action: action.action,
          player: result.player,
          costGold: result.costGold,
          packType: result.packType,
          quality: result.quality,
          replayed: result.replayed,
        }, 200, resolved.setCookie);
      }
      case "reroll_task": {
        const result = await rerollTask(identity, action);
        return json({
          ok: true,
          action: action.action,
          player: result.player,
          task: result.task,
          replayed: result.replayed,
        }, 200, resolved.setCookie);
      }
      case "craft_card":
      case "disenchant_card": {
        const result = action.action === "craft_card"
          ? await craftCard(identity, action)
          : await disenchantCard(identity, action);
        return json({
          ok: true,
          action: action.action,
          player: result.player,
          cardId: result.cardId,
          amount: result.amount,
          kind: result.kind,
          quality: result.quality,
          replayed: result.replayed,
        }, 200, resolved.setCookie);
      }
      case "disenchant_extras": {
        const result = await disenchantExtraCards(identity, action);
        return json({
          ok: true,
          action: action.action,
          player: result.player,
          amount: result.amount,
          cards: result.cards,
          copies: result.copies,
          kind: "bulk-disenchant",
          replayed: result.replayed,
        }, 200, resolved.setCookie);
      }
      case "claim_reward": {
        const result = await claimReward(identity, action);
        return json({
          ok: true,
          action: action.action,
          player: result.player,
          level: result.level,
          reward: result.reward,
          replayed: result.replayed,
        }, 200, resolved.setCookie);
      }
      case "claim_apprentice_reward": {
        const result = await claimApprenticeReward(identity, action);
        return json({
          ok: true,
          action: action.action,
          player: result.player,
          apprenticeMilestoneId: result.milestoneId,
          reward: result.reward,
          replayed: result.replayed,
        }, 200, resolved.setCookie);
      }
      case "record_match": {
        const result = await recordMatch(identity, action);
        return json({
          ok: true,
          action: action.action,
          player: result.player,
          match: result.match,
          rewardGold: result.match.rewardGold,
          replayed: result.replayed,
        }, 200, resolved.setCookie);
      }
      case "update_profile": {
        const result = await updateProfile(identity, action);
        return json({
          ok: true,
          action: action.action,
          player: result.player,
          displayName: result.displayName,
          replayed: result.replayed,
        }, 200, resolved.setCookie);
      }
      case "send_friend_request":
      case "accept_friend_request": {
        const result = action.action === "send_friend_request"
          ? await sendFriendRequest(identity, action)
          : await acceptFriendRequest(identity, action);
        return json({
          ok: true,
          action: action.action,
          player: result.player,
          friendId: result.friendId,
          replayed: result.replayed,
        }, 200, resolved.setCookie);
      }
      case "send_chat": {
        const result = await sendChatMessage(identity, action);
        return json({
          ok: true,
          action: action.action,
          player: result.player,
          message: result.message,
          replayed: result.replayed,
        }, 200, resolved.setCookie);
      }
      case "block_player":
      case "unblock_player":
      case "report_player": {
        const result = action.action === "block_player"
          ? await blockPlayer(identity, { idempotencyKey: action.idempotencyKey, targetId: action.targetId })
          : action.action === "unblock_player"
            ? await unblockPlayer(identity, { idempotencyKey: action.idempotencyKey, targetId: action.targetId })
            : await reportPlayer(identity, {
              idempotencyKey: action.idempotencyKey,
              targetId: action.targetId,
              reason: action.reason,
            });
        return json({
          ok: true,
          action: action.action,
          player: result.player,
          targetId: result.targetId,
          replayed: result.replayed,
        }, 200, resolved.setCookie);
      }
      case "reset_demo": {
        const player = await resetDemoPlayer(identity);
        return json({
          ok: true,
          action: action.action,
          player,
          replayed: false,
        }, 200, resolved.setCookie);
      }
      case "link_device": {
        if (!resolved.anonymousIdentity) {
          throw new GameStoreError("ACCOUNT_LINK_INVALID", "没有可绑定的本机访客档案。", 400);
        }
        const player = await linkAnonymousAccount(identity, resolved.anonymousIdentity);
        return json({
          ok: true,
          action: action.action,
          player,
          linked: true,
          replayed: false,
        }, 200, clearDeviceCookie());
      }
    }
  } catch (error) {
    return handleError(error);
  }
}

async function resolveIdentity(
  request: Request,
): Promise<{ identity: GameIdentity; setCookie?: string; anonymousIdentity?: GameIdentity } | null> {
  const authenticated = await getChatGPTUser();
  if (authenticated) {
    const existingDeviceId = readCookie(request.headers.get("cookie"), ANONYMOUS_COOKIE);
    return {
      identity: {
        email: authenticated.email,
        displayName: authenticated.displayName,
        isDemo: false,
        isAnonymous: false,
        identityKey: authenticated.id
          ? `oai-id:${authenticated.id}`
          : `oai-email:${authenticated.email.trim().toLowerCase()}`,
      },
      ...(isDeviceId(existingDeviceId)
        ? {
            anonymousIdentity: {
              email: `device-${existingDeviceId}@anonymous.ember.local`,
              displayName: "本机指挥官",
              isDemo: false,
              isAnonymous: true,
              identityKey: `device:${existingDeviceId}`,
            },
          }
        : {}),
    };
  }

  if (isLocalRequest(request)) return { identity: DEMO_IDENTITY };

  const existingDeviceId = readCookie(request.headers.get("cookie"), ANONYMOUS_COOKIE);
  const deviceId = isDeviceId(existingDeviceId) ? existingDeviceId : crypto.randomUUID();
  const identity: GameIdentity = {
    email: `device-${deviceId}@anonymous.ember.local`,
    displayName: "本机指挥官",
    isDemo: false,
    isAnonymous: true,
    identityKey: `device:${deviceId}`,
  };
  return {
    identity,
    ...(existingDeviceId === deviceId ? {} : { setCookie: makeDeviceCookie(deviceId) }),
  };
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

function isDeviceId(value: string | null): value is string {
  return value !== null && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function makeDeviceCookie(deviceId: string): string {
  return `${ANONYMOUS_COOKIE}=${encodeURIComponent(deviceId)}; Max-Age=${ANONYMOUS_COOKIE_MAX_AGE}; Path=/; SameSite=Lax; Secure; HttpOnly`;
}

function clearDeviceCookie(): string {
  return `${ANONYMOUS_COOKIE}=; Max-Age=0; Path=/; SameSite=Lax; Secure; HttpOnly`;
}

function isLocalRequest(request: Request): boolean {
  if (process.env.NODE_ENV === "production") return false;

  let hostname: string;
  try {
    hostname = new URL(request.url).hostname.toLowerCase();
  } catch {
    return false;
  }

  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname.endsWith(".localhost")
  );
}

async function readJsonBody(request: Request): Promise<unknown> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new PayloadError("请求内容过大。");
  }

  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new PayloadError("请求内容过大。");
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new PayloadError("请求必须是有效的 JSON。");
  }
}

function parseAction(value: unknown): GameAction {
  if (!isRecord(value) || typeof value.action !== "string") {
    throw new PayloadError("缺少有效的 action。");
  }

  switch (value.action) {
    case "create_ai_match": {
      assertExactKeys(value, ["action", "opponentArchetypeId"], ["action", "opponentArchetypeId", "deckId", "ladderReadyDeckId", "training", "trainingChapterId"]);
      const training = value.training === true;
      if (value.training !== undefined && typeof value.training !== "boolean") {
        throw new PayloadError("training 必须是布尔值。");
      }
      const deckId = value.deckId === undefined ? undefined : parseIdentifier(value.deckId, "deckId");
      const rawLadderReadyDeckId = value.ladderReadyDeckId === undefined
        ? undefined
        : parseIdentifier(value.ladderReadyDeckId, "ladderReadyDeckId");
      const rawTrainingChapterId = value.trainingChapterId === undefined
        ? undefined
        : parseIdentifier(value.trainingChapterId, "trainingChapterId");
      const trainingChapterId = rawTrainingChapterId && getTrainingChapter(rawTrainingChapterId)
        ? rawTrainingChapterId as TrainingChapterId
        : undefined;
      if (rawTrainingChapterId && !trainingChapterId) {
        throw new PayloadError("trainingChapterId 不是有效的教学关卡。");
      }
      const isTraining = training || Boolean(trainingChapterId);
      if (!isTraining && Boolean(deckId) === Boolean(rawLadderReadyDeckId)) {
        throw new PayloadError("deckId 与 ladderReadyDeckId 必须且只能提供一个。");
      }
      if (isTraining && (deckId || rawLadderReadyDeckId)) {
        throw new PayloadError("训练对局使用固定教学牌组，不能指定普通牌组。");
      }
      if (rawLadderReadyDeckId && !LADDER_READY_DECKS.some((deck) => deck.id === rawLadderReadyDeckId)) {
        throw new PayloadError("ladderReadyDeckId 不是有效的天梯预备套牌。");
      }
      return {
        action: "create_ai_match",
        ...(deckId ? { deckId } : {}),
        ...(rawLadderReadyDeckId ? { ladderReadyDeckId: rawLadderReadyDeckId as LadderReadyDeckId } : {}),
        ...(training ? { training: true } : {}),
        ...(trainingChapterId ? { trainingChapterId } : {}),
        opponentArchetypeId: parseIdentifier(value.opponentArchetypeId, "opponentArchetypeId"),
      };
    }
    case "complete_training_chapter": {
      assertExactKeys(value, ["action", "idempotencyKey", "chapterId", "aiProof"]);
      const chapterId = parseIdentifier(value.chapterId, "chapterId");
      if (!getTrainingChapter(chapterId)) {
        throw new PayloadError("chapterId 不是有效的教学关卡。");
      }
      return {
        action: "complete_training_chapter",
        idempotencyKey: parseIdempotencyKey(value.idempotencyKey),
        chapterId: chapterId as TrainingChapterId,
        aiProof: parseAiMatchProof(value.aiProof),
      };
    }
    case "activate_ladder_ready":
      assertExactKeys(value, ["action", "idempotencyKey"]);
      return {
        action: "activate_ladder_ready",
        idempotencyKey: parseIdempotencyKey(value.idempotencyKey),
      };
    case "claim_ladder_ready_deck": {
      assertExactKeys(value, ["action", "idempotencyKey", "deckId"]);
      const deckId = parseIdentifier(value.deckId, "deckId");
      if (!LADDER_READY_DECKS.some((deck) => deck.id === deckId)) {
        throw new PayloadError("deckId 不是有效的天梯预备套牌。");
      }
      return {
        action: "claim_ladder_ready_deck",
        idempotencyKey: parseIdempotencyKey(value.idempotencyKey),
        deckId: deckId as LadderReadyDeckId,
      };
    }
    case "claim_catch_up_pack":
      assertExactKeys(value, ["action", "idempotencyKey"]);
      return {
        action: "claim_catch_up_pack",
        idempotencyKey: parseIdempotencyKey(value.idempotencyKey),
      };
    case "claim_return_quest": {
      assertExactKeys(value, ["action", "idempotencyKey", "stageId"]);
      const stageId = parseIdentifier(value.stageId, "stageId");
      if (stageId !== "reconnect" && stageId !== "rebuild" && stageId !== "battle") {
        throw new PayloadError("stageId 不是有效的回归任务阶段。");
      }
      return {
        action: "claim_return_quest",
        idempotencyKey: parseIdempotencyKey(value.idempotencyKey),
        stageId,
      };
    }
    case "save_deck": {
      assertExactKeys(value, ["action", "idempotencyKey", "deck"]);
      const idempotencyKey = parseIdempotencyKey(value.idempotencyKey);
      if (!isRecord(value.deck)) {
        throw new PayloadError("deck 必须是对象。");
      }
      assertExactKeys(
        value.deck,
        ["name", "format", "cardIds"],
        ["id", "name", "format", "cardIds"],
      );

      const name = parseTrimmedString(value.deck.name, "deck.name", 1, 32);
      const cardIds = parseCardIds(value.deck.cardIds);
      const format = value.deck.format === "wild" ? "wild" : value.deck.format === "standard"
        ? "standard"
        : (() => { throw new PayloadError("deck.format 必须是 standard 或 wild。"); })();
      const id =
        value.deck.id === undefined
          ? undefined
          : parseIdentifier(value.deck.id, "deck.id");

      return {
        action: "save_deck",
        idempotencyKey,
        deck: { ...(id ? { id } : {}), name, format, cardIds },
      };
    }
    case "delete_deck":
      assertExactKeys(value, ["action", "idempotencyKey", "deckId"]);
      return {
        action: "delete_deck",
        idempotencyKey: parseIdempotencyKey(value.idempotencyKey),
        deckId: parseIdentifier(value.deckId, "deckId"),
      };
    case "claim_task":
      assertExactKeys(value, ["action", "idempotencyKey", "taskId"]);
      return {
        action: "claim_task",
        idempotencyKey: parseIdempotencyKey(value.idempotencyKey),
        taskId: parseIdentifier(value.taskId, "taskId"),
      };
    case "open_pack":
      assertExactKeys(value, ["action", "idempotencyKey"], ["action", "idempotencyKey", "packType", "quality"]);
      return {
        action: "open_pack",
        idempotencyKey: parseIdempotencyKey(value.idempotencyKey),
        ...(value.packType === undefined ? {} : { packType: parsePackType(value.packType) }),
        ...(value.quality === undefined ? {} : { quality: parseCardQuality(value.quality) }),
      };
    case "open_packs":
      assertExactKeys(value, ["action", "idempotencyKey", "count"], ["action", "idempotencyKey", "count", "packType", "quality"]);
      if (!Number.isInteger(value.count)) {
        throw new PayloadError("count 必须是整数。");
      }
      return {
        action: "open_packs",
        idempotencyKey: parseIdempotencyKey(value.idempotencyKey),
        count: value.count as number,
        ...(value.packType === undefined ? {} : { packType: parsePackType(value.packType) }),
        ...(value.quality === undefined ? {} : { quality: parseCardQuality(value.quality) }),
      };
    case "claim_weekly_pack":
      assertExactKeys(value, ["action", "idempotencyKey"]);
      return {
        action: "claim_weekly_pack",
        idempotencyKey: parseIdempotencyKey(value.idempotencyKey),
      };
    case "buy_pack":
      assertExactKeys(value, ["action", "idempotencyKey"], ["action", "idempotencyKey", "packType", "quality"]);
      return {
        action: "buy_pack",
        idempotencyKey: parseIdempotencyKey(value.idempotencyKey),
        ...(value.packType === undefined ? {} : { packType: parsePackType(value.packType) }),
        ...(value.quality === undefined ? {} : { quality: parseCardQuality(value.quality) }),
      };
    case "reroll_task":
      assertExactKeys(value, ["action", "idempotencyKey", "taskId"]);
      return {
        action: "reroll_task",
        idempotencyKey: parseIdempotencyKey(value.idempotencyKey),
        taskId: parseIdentifier(value.taskId, "taskId"),
      };
    case "craft_card":
    case "disenchant_card":
      assertExactKeys(value, ["action", "idempotencyKey", "cardId"], ["action", "idempotencyKey", "cardId", "quality"]);
      return {
        action: value.action,
        idempotencyKey: parseIdempotencyKey(value.idempotencyKey),
        cardId: parseIdentifier(value.cardId, "cardId"),
        ...(value.quality === undefined ? {} : { quality: parseCardQuality(value.quality) }),
      };
    case "disenchant_extras":
      assertExactKeys(value, ["action", "idempotencyKey"]);
      return {
        action: "disenchant_extras",
        idempotencyKey: parseIdempotencyKey(value.idempotencyKey),
      };
    case "claim_reward":
      assertExactKeys(value, ["action", "idempotencyKey", "level"]);
      if (typeof value.level !== "number" || !Number.isSafeInteger(value.level) || value.level < 1 || value.level > 100) {
        throw new PayloadError("level 必须是 1–100 的整数。");
      }
      return {
        action: "claim_reward",
        idempotencyKey: parseIdempotencyKey(value.idempotencyKey),
        level: value.level,
      };
    case "claim_apprentice_reward": {
      assertExactKeys(value, ["action", "idempotencyKey", "milestoneId"]);
      const milestoneId = parseIdentifier(value.milestoneId, "milestoneId");
      if (!APPRENTICE_MILESTONES.some((milestone) => milestone.id === milestoneId)) {
        throw new PayloadError("milestoneId 不是有效的新兵里程碑。");
      }
      return {
        action: "claim_apprentice_reward",
        idempotencyKey: parseIdempotencyKey(value.idempotencyKey),
        milestoneId: milestoneId as ApprenticeMilestoneId,
      };
    }
    case "record_match":
      assertExactKeys(value, [
        "action",
        "idempotencyKey",
        "result",
        "mode",
        "opponent",
      ], ["action", "idempotencyKey", "result", "mode", "opponent", "pvpToken", "pvpPlayer", "format", "rankedFormat", "aiProof"]);
      if (value.result !== "win" && value.result !== "loss" && value.result !== "draw") {
        throw new PayloadError("result 必须是 win、loss 或 draw。");
      }
      if (value.mode !== "ai" && value.mode !== "pvp") {
        throw new PayloadError("mode 必须是 ai 或 pvp。");
      }
      const pvpToken = value.pvpToken === undefined
        ? undefined
        : parseTrimmedString(value.pvpToken, "pvpToken", 16, 128);
      const pvpPlayer = value.pvpPlayer === undefined
        ? undefined
        : value.pvpPlayer === 0 || value.pvpPlayer === 1
          ? value.pvpPlayer
          : (() => { throw new PayloadError("pvpPlayer 必须是 0 或 1。"); })();
      const format = value.format === undefined
        ? undefined
        : value.format === "ranked" || value.format === "casual"
          ? value.format
          : (() => { throw new PayloadError("format 必须是 ranked 或 casual。"); })();
      const rankedFormat = value.rankedFormat === undefined
        ? undefined
        : value.rankedFormat === "standard" || value.rankedFormat === "wild"
          ? value.rankedFormat
          : (() => { throw new PayloadError("rankedFormat 必须是 standard 或 wild。"); })();
      if (value.mode === "pvp" && !pvpToken) {
        throw new PayloadError("PVP 对局必须携带服务器对局凭证。");
      }
      const aiProof = value.aiProof === undefined ? undefined : parseAiMatchProof(value.aiProof);
      if (value.mode === "ai" && !aiProof) {
        throw new PayloadError("AI 对局必须携带服务端重放凭证。");
      }
      return {
        action: "record_match",
        idempotencyKey: parseIdempotencyKey(value.idempotencyKey),
        result: value.result,
        mode: value.mode,
        opponent: parseTrimmedString(value.opponent, "opponent", 1, 40),
        ...(pvpToken ? { pvpToken } : {}),
        ...(pvpPlayer === undefined ? {} : { pvpPlayer }),
        ...(format ? { format } : {}),
        ...(rankedFormat ? { rankedFormat } : {}),
        ...(aiProof ? { aiProof } : {}),
      };
    case "reset_demo":
      assertExactKeys(value, ["action"]);
      return { action: "reset_demo" };
    case "link_device":
      assertExactKeys(value, ["action"]);
      return { action: "link_device" };
    case "update_profile":
      assertExactKeys(value, ["action", "idempotencyKey", "displayName"]);
      return {
        action: "update_profile",
        idempotencyKey: parseIdempotencyKey(value.idempotencyKey),
        displayName: parseTrimmedString(value.displayName, "displayName", 1, 24),
      };
    case "send_friend_request":
    case "accept_friend_request":
      assertExactKeys(value, ["action", "idempotencyKey", "friendId"]);
      return {
        action: value.action,
        idempotencyKey: parseIdempotencyKey(value.idempotencyKey),
        friendId: parseIdentifier(value.friendId, "friendId"),
      };
    case "send_chat":
      assertExactKeys(value, ["action", "idempotencyKey", "friendId", "text"]);
      return {
        action: "send_chat",
        idempotencyKey: parseIdempotencyKey(value.idempotencyKey),
        friendId: parseIdentifier(value.friendId, "friendId"),
        text: parseTrimmedString(value.text, "text", 1, 240),
      };
    case "block_player":
    case "unblock_player":
      assertExactKeys(value, ["action", "idempotencyKey", "targetId"]);
      return {
        action: value.action,
        idempotencyKey: parseIdempotencyKey(value.idempotencyKey),
        targetId: parseIdentifier(value.targetId, "targetId"),
      };
    case "report_player":
      assertExactKeys(value, ["action", "idempotencyKey", "targetId", "reason"]);
      return {
        action: "report_player",
        idempotencyKey: parseIdempotencyKey(value.idempotencyKey),
        targetId: parseIdentifier(value.targetId, "targetId"),
        reason: parseTrimmedString(value.reason, "reason", 2, 200),
      };
    default:
      throw new PayloadError("不支持的 action。");
  }
}

function parseIdempotencyKey(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)
  ) {
    throw new PayloadError(
      "idempotencyKey 必须是 8–128 位字母、数字或 . _ : -。",
    );
  }
  return value;
}

function parseAiMatchProof(value: unknown): AiMatchProof {
  if (!isRecord(value)) throw new PayloadError("aiProof 必须是对象。");
  assertExactKeys(value, ["ticketToken", "seed", "startingPlayer", "rankedFormat", "playerDeck", "opponentArchetypeId", "commands"]);
  const ticketToken = parseTrimmedString(value.ticketToken, "aiProof.ticketToken", 16, 128);
  if (typeof value.seed !== "number" || !Number.isSafeInteger(value.seed) || value.seed < 0 || value.seed > 0x7fffffff) {
    throw new PayloadError("aiProof.seed 必须是合法整数。");
  }
  if (value.startingPlayer !== 0 && value.startingPlayer !== 1) {
    throw new PayloadError("aiProof.startingPlayer 必须是 0 或 1。");
  }
  if (value.rankedFormat !== "standard" && value.rankedFormat !== "wild") {
    throw new PayloadError("aiProof.rankedFormat 必须是 standard 或 wild。");
  }
  const playerDeck = parseCardIds(value.playerDeck);
  const opponentArchetypeId = parseIdentifier(value.opponentArchetypeId, "aiProof.opponentArchetypeId");
  if (
    !Array.isArray(value.commands) ||
    value.commands.length < 1 ||
    value.commands.length > MAX_AI_PROOF_COMMANDS
  ) {
    throw new PayloadError(`aiProof.commands 必须包含 1–${MAX_AI_PROOF_COMMANDS} 条命令。`);
  }
  const allowedTypes = new Set([
    "mulligan", "play-card", "trade-card", "prepare-card", "attack", "hero-attack",
    "choose-discover", "choose-one", "hero-power", "use-coin", "end-turn", "concede",
  ]);
  const commands = value.commands.map((raw, index) => {
    if (!isRecord(raw) || typeof raw.type !== "string" || !allowedTypes.has(raw.type)) {
      throw new PayloadError(`aiProof.commands[${index}] 类型无效。`);
    }
    if (raw.player !== 0 && raw.player !== 1) {
      throw new PayloadError(`aiProof.commands[${index}].player 无效。`);
    }
    if (raw.commandId !== undefined) parseIdempotencyKey(raw.commandId);
    if (raw.expectedVersion !== undefined && (typeof raw.expectedVersion !== "number" || !Number.isSafeInteger(raw.expectedVersion) || raw.expectedVersion < 0)) {
      throw new PayloadError(`aiProof.commands[${index}].expectedVersion 无效。`);
    }
    return raw;
  }) as unknown as AiMatchProof["commands"];
  return { ticketToken, seed: value.seed, startingPlayer: value.startingPlayer, rankedFormat: value.rankedFormat, playerDeck, opponentArchetypeId, commands };
}

function parseIdentifier(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)
  ) {
    throw new PayloadError(`${field} 格式无效。`);
  }
  return value;
}

function parseCardIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length !== 30) {
    throw new PayloadError("deck.cardIds 必须恰好包含 30 张卡牌。");
  }

  const cardIds = value.map((cardId) => {
    if (
      typeof cardId !== "string" ||
      !/^[a-z0-9][a-z0-9-]{1,63}$/.test(cardId)
    ) {
      throw new PayloadError("deck.cardIds 包含无效卡牌 ID。");
    }
    return cardId;
  });
  return cardIds;
}

function parseTrimmedString(
  value: unknown,
  field: string,
  minLength: number,
  maxLength: number,
): string {
  if (typeof value !== "string") {
    throw new PayloadError(`${field} 必须是字符串。`);
  }
  const trimmed = value.trim();
  if (
    trimmed.length < minLength ||
    trimmed.length > maxLength ||
    /[\u0000-\u001f\u007f]/.test(trimmed)
  ) {
    throw new PayloadError(
      `${field} 长度必须在 ${minLength}–${maxLength} 个字符之间。`,
    );
  }
  return trimmed;
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: string[],
  allowed = required,
): void {
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  ) {
    throw new PayloadError("请求字段缺失或包含未支持的字段。");
  }
}

function parsePackType(value: unknown): PackType {
  if (!isPackType(value)) throw new PayloadError("packType 不是有效的卡包类型。");
  return value;
}

function parseCardQuality(value: unknown): CardQuality {
  if (value !== "normal" && value !== "golden") throw new PayloadError("quality 不是有效的卡牌品质。");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unauthorized(): Response {
  return json(
    {
      ok: false,
      error: {
        code: "AUTH_REQUIRED",
        message: "请先使用 ChatGPT 登录。",
      },
    },
    401,
  );
}

function handleError(error: unknown): Response {
  if (error instanceof PayloadError) {
    return json(
      {
        ok: false,
        error: {
          code: error.code,
          message: error.message,
        },
      },
      400,
    );
  }

  if (error instanceof GameStoreError) {
    return json(
      {
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      },
      error.status,
    );
  }

  console.error("Game API failed", error);
  return json(
    {
      ok: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "服务暂时不可用，请稍后重试。",
      },
    },
    500,
  );
}

function json(body: unknown, status = 200, setCookie?: string): Response {
  const response = Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
    },
  });
  if (setCookie) response.headers.set("set-cookie", setCookie);
  return response;
}
