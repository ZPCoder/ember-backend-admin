import { getChatGPTUser } from "../../chatgpt-auth";
import {
  claimTask,
  GameStoreError,
  getPlayerState,
  openPack,
  recordMatch,
  resetDemoPlayer,
  saveDeck,
  type GameIdentity,
  type MatchMode,
  type MatchResult,
} from "../../../db/game-store";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 32 * 1024;
const DEMO_IDENTITY: GameIdentity = {
  email: "demo@local.invalid",
  displayName: "本地演示玩家",
  isDemo: true,
};

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
      action: "record_match";
      idempotencyKey: string;
      result: MatchResult;
      mode: MatchMode;
      opponent: string;
    }
  | {
      action: "reset_demo";
    };

class PayloadError extends Error {
  readonly code = "INVALID_PAYLOAD";
}

export async function GET(request: Request): Promise<Response> {
  try {
    const identity = await resolveIdentity(request);
    if (!identity) return unauthorized();

    const player = await getPlayerState(identity);
    return json({
      ok: true,
      identity: {
        email: identity.email,
        displayName: identity.displayName,
        isDemo: identity.isDemo,
      },
      player,
    });
  } catch (error) {
    return handleError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const identity = await resolveIdentity(request);
    if (!identity) return unauthorized();

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
        });
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
        });
      }
      case "open_pack": {
        const result = await openPack(identity, action);
        return json({
          ok: true,
          action: action.action,
          player: result.player,
          openedCards: result.openedCards,
          replayed: result.replayed,
        });
      }
      case "record_match": {
        const result = await recordMatch(identity, action);
        return json({
          ok: true,
          action: action.action,
          player: result.player,
          match: result.match,
          replayed: result.replayed,
        });
      }
      case "reset_demo": {
        const player = await resetDemoPlayer(identity);
        return json({
          ok: true,
          action: action.action,
          player,
          replayed: false,
        });
      }
    }
  } catch (error) {
    return handleError(error);
  }
}

async function resolveIdentity(
  request: Request,
): Promise<GameIdentity | null> {
  const authenticated = await getChatGPTUser();
  if (authenticated) {
    return {
      email: authenticated.email,
      displayName: authenticated.displayName,
      isDemo: false,
    };
  }

  return isLocalRequest(request) ? DEMO_IDENTITY : null;
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
    case "record_match":
      assertExactKeys(value, [
        "action",
        "idempotencyKey",
        "result",
        "mode",
        "opponent",
      ]);
      if (value.result !== "win" && value.result !== "loss") {
        throw new PayloadError("result 必须是 win 或 loss。");
      }
      if (value.mode !== "ai" && value.mode !== "pvp") {
        throw new PayloadError("mode 必须是 ai 或 pvp。");
      }
      return {
        action: "record_match",
        idempotencyKey: parseIdempotencyKey(value.idempotencyKey),
        result: value.result,
        mode: value.mode,
        opponent: parseTrimmedString(value.opponent, "opponent", 1, 40),
      };
    case "reset_demo":
      assertExactKeys(value, ["action"]);
      return { action: "reset_demo" };
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

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
    },
  });
}
