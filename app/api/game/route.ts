import { getChatGPTUser } from "../../chatgpt-auth";
import {
  claimTask,
  claimReward,
  claimWeeklyPack,
  acceptFriendRequest,
  blockPlayer,
  buyPack,
  craftCard,
  disenchantCard,
  GameStoreError,
  getPlayerState,
  linkAnonymousAccount,
  openPack,
  recordMatch,
  rerollTask,
  resetDemoPlayer,
  reportPlayer,
  saveDeck,
  sendChatMessage,
  sendFriendRequest,
  unblockPlayer,
  updateProfile,
  type GameIdentity,
  type AiMatchProof,
  type MatchMode,
  type MatchFormat,
  type MatchResult,
} from "../../../db/game-store";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 32 * 1024;
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
      action: "save_deck";
      idempotencyKey: string;
      deck: {
        id?: string;
        name: string;
        cardIds: string[];
      };
    }
  | {
      action: "claim_task";
      idempotencyKey: string;
      taskId: string;
    }
  | {
      action: "open_pack";
      idempotencyKey: string;
    }
  | {
      action: "claim_weekly_pack";
      idempotencyKey: string;
    }
  | {
      action: "buy_pack";
      idempotencyKey: string;
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
    }
  | {
      action: "claim_reward";
      idempotencyKey: string;
      level: number;
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
    case "save_deck": {
      assertExactKeys(value, ["action", "idempotencyKey", "deck"]);
      const idempotencyKey = parseIdempotencyKey(value.idempotencyKey);
      if (!isRecord(value.deck)) {
        throw new PayloadError("deck 必须是对象。");
      }
      assertExactKeys(
        value.deck,
        ["name", "cardIds"],
        ["id", "name", "cardIds"],
      );

      const name = parseTrimmedString(value.deck.name, "deck.name", 1, 32);
      const cardIds = parseCardIds(value.deck.cardIds);
      const id =
        value.deck.id === undefined
          ? undefined
          : parseIdentifier(value.deck.id, "deck.id");

      return {
        action: "save_deck",
        idempotencyKey,
        deck: { ...(id ? { id } : {}), name, cardIds },
      };
    }
    case "claim_task":
      assertExactKeys(value, ["action", "idempotencyKey", "taskId"]);
      return {
        action: "claim_task",
        idempotencyKey: parseIdempotencyKey(value.idempotencyKey),
        taskId: parseIdentifier(value.taskId, "taskId"),
      };
    case "open_pack":
      assertExactKeys(value, ["action", "idempotencyKey"]);
      return {
        action: "open_pack",
        idempotencyKey: parseIdempotencyKey(value.idempotencyKey),
      };
    case "claim_weekly_pack":
      assertExactKeys(value, ["action", "idempotencyKey"]);
      return {
        action: "claim_weekly_pack",
        idempotencyKey: parseIdempotencyKey(value.idempotencyKey),
      };
    case "buy_pack":
      assertExactKeys(value, ["action", "idempotencyKey"]);
      return {
        action: "buy_pack",
        idempotencyKey: parseIdempotencyKey(value.idempotencyKey),
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
      assertExactKeys(value, ["action", "idempotencyKey", "cardId"]);
      return {
        action: value.action,
        idempotencyKey: parseIdempotencyKey(value.idempotencyKey),
        cardId: parseIdentifier(value.cardId, "cardId"),
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
    case "record_match":
      assertExactKeys(value, [
        "action",
        "idempotencyKey",
        "result",
        "mode",
        "opponent",
      ], ["action", "idempotencyKey", "result", "mode", "opponent", "pvpToken", "pvpPlayer", "format", "aiProof"]);
      if (value.result !== "win" && value.result !== "loss") {
        throw new PayloadError("result 必须是 win 或 loss。");
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
      if (value.mode === "pvp" && (!pvpToken || pvpPlayer === undefined)) {
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
  assertExactKeys(value, ["seed", "startingPlayer", "playerDeck", "opponentArchetypeId", "commands"]);
  if (typeof value.seed !== "number" || !Number.isSafeInteger(value.seed) || value.seed < 0 || value.seed > 0x7fffffff) {
    throw new PayloadError("aiProof.seed 必须是合法整数。");
  }
  if (value.startingPlayer !== 0 && value.startingPlayer !== 1) {
    throw new PayloadError("aiProof.startingPlayer 必须是 0 或 1。");
  }
  const playerDeck = parseCardIds(value.playerDeck);
  const opponentArchetypeId = parseIdentifier(value.opponentArchetypeId, "aiProof.opponentArchetypeId");
  if (!Array.isArray(value.commands) || value.commands.length < 1 || value.commands.length > 400) {
    throw new PayloadError("aiProof.commands 必须包含 1–400 条命令。");
  }
  const allowedTypes = new Set([
    "mulligan", "play-card", "trade-card", "attack", "hero-attack",
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
  return { seed: value.seed, startingPlayer: value.startingPlayer, playerDeck, opponentArchetypeId, commands };
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
