/** Cloudflare Worker entry point for 余烬协议. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import {
  applyCommand,
  createMatch,
  validateDeck,
  type BattleCommand,
  type MatchState,
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

type PvpDatabase = {
  prepare(query: string): {
    bind(...values: unknown[]): {
      all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
      first<T = Record<string, unknown>>(): Promise<T | null>;
      run(): Promise<{ meta?: { changes?: number; last_row_id?: number } }>;
    };
    all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
    first<T = Record<string, unknown>>(): Promise<T | null>;
    run(): Promise<{ meta?: { changes?: number; last_row_id?: number } }>;
  };
  batch(statements: Array<ReturnType<PvpDatabase["prepare"]>>): Promise<unknown>;
};

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

type PvpMessage = Record<string, unknown>;
type PvpPeer = {
  socket?: WebSocket;
  clientId: string;
  id: string;
  name: string;
  room: string | null;
  queue?: PvpMessage[];
};
type PvpRoom = { code: string; peers: PvpPeer[]; nextSequence: number };

const pvpRooms = new Map<string, PvpRoom>();
const pvpPeers = new Map<WebSocket, PvpPeer>();
const pvpPollSessions = new Map<string, PvpPeer>();
const pvpAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ";

type PvpDbSession = {
  client_id: string;
  player_id: string;
  name: string;
  room_code: string | null;
  updated_at: number;
};
type PvpDbRoom = { code: string; host_client_id: string; guest_client_id: string | null; next_sequence: number };
type PvpDbReady = { client_id: string; room_code: string; deck_json: string; updated_at: number };
type PvpDbMatch = { room_code: string; match_token: string; state_json: string; created_at: number; updated_at: number };

const PVP_SESSION_TTL_MS = 30 * 60 * 1000;
const PVP_MAX_BODY_BYTES = 32 * 1024;

function redactPvpStateForViewer(state: MatchState, viewer: 0 | 1): MatchState {
  const snapshot = JSON.parse(JSON.stringify(state)) as MatchState;
  snapshot.players = snapshot.players.map((player, index) => {
    if (index === viewer) return player;
    return {
      ...player,
      // Counts are enough for the opponent UI; card identities must remain
      // server-side until a card is publicly played.
      deck: (player.deck ?? []).map(() => "__hidden-card__"),
      hand: (player.hand ?? []).map(() => "__hidden-card__"),
      secrets: (player.secrets ?? []).map((_, secretIndex) => ({
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
    if (event.player === viewer) return event;
    if (event.type === "secret-armed") {
      return {
        ...event,
        message: `玩家 ${event.player ?? 1} 设置了一个奥秘。`,
        data: undefined,
      };
    }
    if (event.type === "card-drawn" || event.type === "card-burned" || event.type === "card-traded") {
      const safeData = { ...(event.data ?? {}) };
      delete safeData.cardId;
      return {
        ...event,
        message: event.type === "card-traded" ? "对手完成了一次可交易循环。" : event.message,
        data: safeData,
      };
    }
    if (event.type === "discover-started") {
      return {
        ...event,
        message: "对手正在发现一张卡牌。",
        data: undefined,
      };
    }
    if (event.type === "discover-chosen") {
      return {
        ...event,
        message: "对手完成了发现选择。",
        data: undefined,
      };
    }
    if (event.type === "choose-one-started") {
      return {
        ...event,
        message: "对手正在完成抉择。",
        data: undefined,
      };
    }
    if (event.type === "choose-one-chosen") {
      return {
        ...event,
        message: "对手完成了抉择。",
        data: undefined,
      };
    }
    return event;
  });
  return snapshot;
}

function redactPvpCommandForViewer(command: BattleCommand, viewer: 0 | 1): BattleCommand {
  if (command.player === viewer) return command;
  if (command.type === "choose-discover" || command.type === "trade-card") {
    return { ...command, cardId: "__hidden-card__" };
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
    ]).then(() => undefined).catch((error) => {
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
  return db.prepare(`SELECT code, host_client_id, guest_client_id, next_sequence FROM pvp_rooms WHERE code = ?`)
    .bind(code).first<PvpDbRoom>();
}

async function getPvpDbReady(db: PvpDatabase, clientId: string): Promise<PvpDbReady | null> {
  return db.prepare(`SELECT client_id, room_code, deck_json, updated_at FROM pvp_ready WHERE client_id = ?`)
    .bind(clientId).first<PvpDbReady>();
}

async function getPvpDbMatch(db: PvpDatabase, roomCode: string): Promise<PvpDbMatch | null> {
  return db.prepare(`SELECT room_code, match_token, state_json, created_at, updated_at FROM pvp_matches WHERE room_code = ?`)
    .bind(roomCode).first<PvpDbMatch>();
}

async function prunePvpDb(db: PvpDatabase): Promise<void> {
  const cutoff = Date.now() - PVP_SESSION_TTL_MS;
  const stale = await db.prepare(`SELECT client_id, player_id, name, room_code, updated_at FROM pvp_sessions WHERE updated_at < ? LIMIT 50`)
    .bind(cutoff).all<PvpDbSession>();
  for (const session of stale.results ?? []) {
    await dbLeaveRoom(db, session);
    await db.prepare(`DELETE FROM pvp_messages WHERE client_id = ?`).bind(session.client_id).run();
    await db.prepare(`DELETE FROM pvp_session_identities WHERE client_id = ?`).bind(session.client_id).run();
    await db.prepare(`DELETE FROM pvp_sessions WHERE client_id = ?`).bind(session.client_id).run();
  }
  await db.batch([
    db.prepare(`DELETE FROM pvp_messages WHERE created_at < ?`).bind(cutoff),
    db.prepare(`DELETE FROM pvp_ready WHERE updated_at < ?`).bind(cutoff),
    db.prepare(`DELETE FROM pvp_matches WHERE updated_at < ?`).bind(cutoff),
    db.prepare(`DELETE FROM pvp_match_participants WHERE created_at < ?`).bind(cutoff),
  ]);
}

function parsePvpDeck(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length !== 30 || value.some((cardId) => typeof cardId !== "string")) return null;
  const deck = value.map(String);
  return validateDeck(deck).valid ? deck : null;
}

function parsePvpState(value: string): MatchState | null {
  try {
    const parsed = JSON.parse(value) as MatchState;
    return parsed && typeof parsed === "object" && Array.isArray(parsed.players) && typeof parsed.version === "number"
      ? parsed
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
  const payload = { type: "room_state", room: room.code, payload: { players } };
  await Promise.all([room.host_client_id, room.guest_client_id].filter(Boolean).map((clientId) => queuePvpDbMessage(db, clientId as string, payload)));
}

async function clearPvpMatchIfActive(db: PvpDatabase, roomCode: string): Promise<void> {
  const match = await getPvpDbMatch(db, roomCode);
  const state = match ? parsePvpState(match.state_json) : null;
  // Keep completed snapshots long enough for /api/game to verify the result
  // even if one player leaves the room immediately after the final action.
  if (state?.phase === "game-over") return;
  await db.prepare(`DELETE FROM pvp_matches WHERE room_code = ?`).bind(roomCode).run();
}

async function dbRestoreSession(db: PvpDatabase, session: PvpDbSession): Promise<void> {
  const now = Date.now();
  await db.prepare(`DELETE FROM pvp_messages WHERE client_id = ?`).bind(session.client_id).run();
  await queuePvpDbMessage(db, session.client_id, { type: "welcome", playerId: session.player_id, message: "连接成功" });
  if (!session.room_code) return;
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
  const matchState = match ? parsePvpState(match.state_json) : null;
  if (matchState) {
    const viewer = isHost ? 0 : 1;
    await queuePvpDbMessage(db, session.client_id, {
      type: "match_sync",
      room: room.code,
      payload: { state: redactPvpStateForViewer(matchState, viewer), matchToken: match.match_token },
    });
  }
}

async function dbLeaveRoom(db: PvpDatabase, session: PvpDbSession): Promise<void> {
  if (!session.room_code) return;
  const leavingRoomCode = session.room_code;
  const room = await getPvpDbRoom(db, session.room_code);
  if (!room) {
    await db.prepare(`DELETE FROM pvp_ready WHERE client_id = ?`).bind(session.client_id).run();
    await clearPvpMatchIfActive(db, leavingRoomCode);
    await db.prepare(`UPDATE pvp_sessions SET room_code = NULL, updated_at = ? WHERE client_id = ?`)
      .bind(Date.now(), session.client_id).run();
    return;
  }
  const opponentId = room.host_client_id === session.client_id ? room.guest_client_id : room.host_client_id;
  if (opponentId) {
    await queuePvpDbMessage(db, opponentId, { type: "peer_left", peerName: session.name, message: `${session.name} 已离开房间` });
    const nextRoom = room.host_client_id === session.client_id
      ? { host: opponentId, guest: null }
      : { host: room.host_client_id, guest: null };
    await db.prepare(`UPDATE pvp_rooms SET host_client_id = ?, guest_client_id = ?, updated_at = ? WHERE code = ?`)
      .bind(nextRoom.host, nextRoom.guest, Date.now(), room.code).run();
    await db.prepare(`UPDATE pvp_sessions SET room_code = NULL, updated_at = ? WHERE client_id = ?`)
      .bind(Date.now(), session.client_id).run();
    await db.prepare(`DELETE FROM pvp_ready WHERE room_code = ?`).bind(room.code).run();
    await clearPvpMatchIfActive(db, room.code);
    await db.prepare(`UPDATE pvp_sessions SET room_code = ? WHERE client_id = ?`).bind(room.code, opponentId).run();
    const remaining = await getPvpDbRoom(db, room.code);
    if (remaining) await dbRoomState(db, remaining);
  } else {
    await db.prepare(`DELETE FROM pvp_ready WHERE room_code = ?`).bind(room.code).run();
    await clearPvpMatchIfActive(db, room.code);
    await db.prepare(`DELETE FROM pvp_rooms WHERE code = ?`).bind(room.code).run();
    await db.prepare(`UPDATE pvp_sessions SET room_code = NULL, updated_at = ? WHERE client_id = ?`)
      .bind(Date.now(), session.client_id).run();
  }
}

async function dbCreateRoom(db: PvpDatabase, session: PvpDbSession): Promise<void> {
  await dbLeaveRoom(db, session);
  let code = "";
  for (let attempt = 0; attempt < 12; attempt += 1) {
    code = Array.from({ length: 4 }, () => pvpAlphabet[Math.floor(Math.random() * pvpAlphabet.length)]).join("");
    if (!(await getPvpDbRoom(db, code))) break;
  }
  const now = Date.now();
  await db.prepare(`INSERT INTO pvp_rooms (code, host_client_id, guest_client_id, next_sequence, created_at, updated_at) VALUES (?, ?, NULL, 0, ?, ?)`)
    .bind(code, session.client_id, now, now).run();
  await db.prepare(`UPDATE pvp_sessions SET room_code = ?, updated_at = ? WHERE client_id = ?`)
    .bind(code, now, session.client_id).run();
  await queuePvpDbMessage(db, session.client_id, { type: "room_created", room: code, message: "房间已创建，等待对手加入" });
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
  await dbLeaveRoom(db, session);
  const now = Date.now();
  await db.prepare(`UPDATE pvp_rooms SET guest_client_id = ?, updated_at = ? WHERE code = ? AND guest_client_id IS NULL`)
    .bind(session.client_id, now, code).run();
  const updated = await getPvpDbRoom(db, code);
  if (!updated || updated.guest_client_id !== session.client_id) return queuePvpDbMessage(db, session.client_id, { type: "error", message: "房间刚刚被其他玩家加入" });
  await db.prepare(`UPDATE pvp_sessions SET room_code = ?, updated_at = ? WHERE client_id = ?`).bind(code, now, session.client_id).run();
  await queuePvpDbMessage(db, session.client_id, { type: "room_joined", room: code, message: "已加入房间" });
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

async function nextPvpSequence(db: PvpDatabase, room: PvpDbRoom): Promise<number> {
  const now = Date.now();
  await db.prepare(`UPDATE pvp_rooms SET next_sequence = next_sequence + 1, updated_at = ? WHERE code = ?`)
    .bind(now, room.code).run();
  const updated = await getPvpDbRoom(db, room.code);
  return updated?.next_sequence ?? room.next_sequence + 1;
}

function pvpRoleIndex(room: PvpDbRoom, clientId: string): 0 | 1 | null {
  if (room.host_client_id === clientId) return 0;
  if (room.guest_client_id === clientId) return 1;
  return null;
}

function canonicalCommand(value: unknown, role: 0 | 1): BattleCommand | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const type = raw.type;
  if (type !== "mulligan" && type !== "play-card" && type !== "trade-card" && type !== "attack" && type !== "hero-attack" && type !== "hero-power" && type !== "use-coin" && type !== "end-turn" && type !== "choose-discover" && type !== "choose-one" && type !== "concede") return null;
  const command = { ...raw, type, player: role } as BattleCommand;
  if (role === 1 && command.target?.kind === "hero") {
    command.target = { ...command.target, player: command.target.player === 0 ? 1 : 0 };
  }
  return command;
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
    const deckIds = parsePvpDeck(payload.deckIds);
    if (!deckIds) return queuePvpDbMessage(db, session.client_id, { type: "action_rejected", action, message: "卡组无效，无法准备。" });
    const now = Date.now();
    await db.prepare(`INSERT INTO pvp_ready (client_id, room_code, deck_json, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(client_id) DO UPDATE SET room_code = excluded.room_code, deck_json = excluded.deck_json, updated_at = excluded.updated_at`)
      .bind(session.client_id, room.code, JSON.stringify(deckIds), now).run();
    const sequence = await nextPvpSequence(db, room);
    const opponentId = role === 0 ? room.guest_client_id : room.host_client_id;
    if (opponentId) await queuePvpDbMessage(db, opponentId, { type: "action", playerId: session.player_id, peerName: session.name, sequence, action, payload: { ready: true } });
    await queuePvpDbMessage(db, session.client_id, { type: "action_ack", action, sequence });
    return;
  }

  if (action === "match_start") {
    if (role !== 0) return queuePvpDbMessage(db, session.client_id, { type: "action_rejected", action, message: "只有房主可以开始对局。" });
    if (!room.guest_client_id) return queuePvpDbMessage(db, session.client_id, { type: "action_rejected", action, message: "等待对手加入房间。" });
    const hostReady = await getPvpDbReady(db, room.host_client_id);
    const guestReady = await getPvpDbReady(db, room.guest_client_id);
    let hostDeck: string[] | null = null;
    let guestDeck: string[] | null = null;
    try {
      hostDeck = hostReady ? parsePvpDeck(JSON.parse(hostReady.deck_json)) : null;
      guestDeck = guestReady ? parsePvpDeck(JSON.parse(guestReady.deck_json)) : null;
    } catch {
      hostDeck = null;
      guestDeck = null;
    }
    if (!hostDeck || !guestDeck) return queuePvpDbMessage(db, session.client_id, { type: "action_rejected", action, message: "双方都需要先用合法卡组准备。" });
    const existing = await getPvpDbMatch(db, room.code);
    const existingState = existing ? parsePvpState(existing.state_json) : null;
    if (existingState?.phase === "main" || existingState?.phase === "mulligan") {
      return queuePvpDbMessage(db, session.client_id, { type: "action_rejected", action, message: "对局已经开始，请等待本局结束。" });
    }
    const suppliedSeed = Number(payload.seed);
    const seed = Number.isSafeInteger(suppliedSeed) ? suppliedSeed : Math.floor(Math.random() * 0x7fffffff);
    const state = createMatch({ decks: [hostDeck, guestDeck], startingPlayer: 0, seed });
    const matchToken = crypto.randomUUID();
    const now = Date.now();
    const hostIdentity = await getPvpDbIdentity(db, room.host_client_id);
    const guestIdentity = await getPvpDbIdentity(db, room.guest_client_id);
    await db.prepare(`INSERT INTO pvp_matches (room_code, match_token, state_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(room_code) DO UPDATE SET match_token = excluded.match_token, state_json = excluded.state_json, updated_at = excluded.updated_at`)
      .bind(room.code, matchToken, JSON.stringify(state), now, now).run();
    await db.prepare(`INSERT INTO pvp_match_participants (match_token, room_code, host_identity, guest_identity, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(match_token) DO UPDATE SET room_code = excluded.room_code, host_identity = excluded.host_identity,
        guest_identity = excluded.guest_identity, created_at = excluded.created_at`)
      .bind(matchToken, room.code, hostIdentity, guestIdentity, now).run();
    const sequence = await nextPvpSequence(db, room);
    const startPayload = (viewer: 0 | 1) => ({
      seed,
      // The client only needs its own deck to open the pre-sync mulligan
      // screen. The authoritative snapshot follows through command sync.
      deck: viewer === 0 ? hostDeck : guestDeck,
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
    return;
  }

  if (action === "rematch") {
    if (role !== 0) return queuePvpDbMessage(db, session.client_id, { type: "action_rejected", action, message: "只有房主可以发起再来一局。" });
    if (!room.guest_client_id) return queuePvpDbMessage(db, session.client_id, { type: "action_rejected", action, message: "等待对手加入房间。" });
    const existing = await getPvpDbMatch(db, room.code);
    const existingState = existing ? parsePvpState(existing.state_json) : null;
    if (!existingState || existingState.phase !== "game-over") {
      return queuePvpDbMessage(db, session.client_id, { type: "action_rejected", action, message: "本局尚未结束，暂时不能重新开始。" });
    }
    const now = Date.now();
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
  const current = match ? parsePvpState(match.state_json) : null;
  const command = canonicalCommand(payload.command, role);
  if (!match || !current || !command) {
    return queuePvpDbMessage(db, session.client_id, { type: "action_rejected", action, commandId: typeof payload.command === "object" && payload.command ? (payload.command as Record<string, unknown>).commandId : undefined, message: "对局指令无效或对局尚未开始。" });
  }
  const transition = applyCommand(current, command);
  if (!transition.accepted) {
    return queuePvpDbMessage(db, session.client_id, {
      type: "action_rejected",
      action,
      commandId: command.commandId,
      ...(transition.error?.code === "version-conflict" ? { resync: true } : {}),
      message: transition.error?.message ?? "服务器拒绝了这条指令。",
    });
  }
  const now = Date.now();
  const updated = await db.prepare(`UPDATE pvp_matches SET state_json = ?, updated_at = ? WHERE room_code = ? AND match_token = ? AND state_json = ?`)
    .bind(JSON.stringify(transition.state), now, room.code, match.match_token, match.state_json).run();
  if ((updated.meta?.changes ?? 0) !== 1) {
    return queuePvpDbMessage(db, session.client_id, {
      type: "action_rejected",
      action,
      commandId: command.commandId,
      resync: true,
      message: "对局状态刚刚更新，请等待同步后再操作。",
    });
  }
  const sequence = await nextPvpSequence(db, room);
  // Send the post-transition snapshot as well as the command. Clients render
  // this authoritative state directly, so refreshes and slow polling cannot
  // leave either side one reducer step behind.
  const recipients = [room.host_client_id, room.guest_client_id].filter(Boolean) as string[];
  await Promise.all(recipients.map(async (clientId) => {
    const viewer = pvpRoleIndex(room, clientId);
    if (viewer === null) return;
    const actionPayload = {
      command: redactPvpCommandForViewer(command, viewer),
      state: redactPvpStateForViewer(transition.state, viewer),
      stateVersion: transition.state.version,
      result: transition.state.result,
      matchToken: match.match_token,
    };
    await queuePvpDbMessage(db, clientId, {
      type: "action",
      playerId: session.player_id,
      peerName: session.name,
      sequence,
      action,
      payload: actionPayload,
    });
  }));
}

async function handlePvpDbMessage(db: PvpDatabase, session: PvpDbSession, message: PvpMessage): Promise<void> {
  switch (message.type) {
    case "hello": {
      const name = typeof message.name === "string" ? message.name.trim().slice(0, 24) : session.name;
      await db.prepare(`UPDATE pvp_sessions SET name = ?, updated_at = ? WHERE client_id = ?`).bind(name || "旅者", Date.now(), session.client_id).run();
      break;
    }
    case "create_room": await dbCreateRoom(db, session); break;
    case "join_room": await dbJoinRoom(db, session, typeof message.room === "string" ? message.room.trim().toUpperCase() : ""); break;
    case "action": await dbRelayAction(db, session, message); break;
    case "sync": await dbRestoreSession(db, session); break;
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
    payload: { players },
  }));
}

function leavePvpRoom(peer: PvpPeer): void {
  const code = peer.room;
  if (!code) return;
  peer.room = null;
  const room = pvpRooms.get(code);
  if (!room) return;
  room.peers = room.peers.filter((candidate) => candidate !== peer);
  room.peers.forEach((other) => pvpJson(other, {
    type: "peer_left",
    peerName: peer.name,
    message: `${peer.name} 已离开房间`,
  }));
  if (room.peers.length === 0) pvpRooms.delete(code);
  else pvpRoomState(room);
}

function leavePvpPeer(peer: PvpPeer): void {
  if (peer.socket) pvpPeers.delete(peer.socket);
  if (pvpPollSessions.get(peer.clientId) === peer) pvpPollSessions.delete(peer.clientId);
  leavePvpRoom(peer);
}

function createPvpRoom(peer: PvpPeer): void {
  leavePvpRoom(peer);
  let code = "";
  do {
    code = Array.from({ length: 4 }, () => pvpAlphabet[Math.floor(Math.random() * pvpAlphabet.length)]).join("");
  } while (pvpRooms.has(code));
  const room: PvpRoom = { code, peers: [peer], nextSequence: 0 };
  pvpRooms.set(code, room);
  peer.room = code;
  pvpJson(peer, { type: "room_created", room: code, message: "房间已创建，等待对手加入" });
  pvpRoomState(room);
}

function joinPvpRoom(peer: PvpPeer, code: string): void {
  const room = pvpRooms.get(code);
  if (!room) return pvpError(peer, `房间 ${code} 不存在`);
  if (room.peers.length >= 2) return pvpError(peer, "房间已满");
  leavePvpRoom(peer);
  room.peers.push(peer);
  peer.room = room.code;
  pvpJson(peer, { type: "room_joined", room: room.code, message: "已加入房间" });
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

function relayPvpAction(peer: PvpPeer, message: PvpMessage): void {
  const room = peer.room ? pvpRooms.get(peer.room) : null;
  if (!room) return pvpError(peer, "请先创建或加入房间");
  const action = typeof message.action === "string" ? message.action : "";
  if (!["ready", "match_start", "command", "rematch"].includes(action)) {
    return pvpError(peer, "联机指令类型无效");
  }
  if (action === "rematch") {
    if (room.peers[0] !== peer) return pvpError(peer, "只有房主可以发起再来一局");
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
  const rawPayload = message.payload && typeof message.payload === "object" ? message.payload : {};
  const sequence = ++room.nextSequence;
  if (action === "match_start" && rawPayload && !Array.isArray(rawPayload)) {
    const supplied = rawPayload as Record<string, unknown>;
    const decks = Array.isArray(supplied.decks) && supplied.decks.length === 2
      ? supplied.decks.map((deck) => Array.isArray(deck) ? deck.map(String) : [])
      : [];
    const seed = Number(supplied.seed);
    const matchToken = typeof supplied.matchToken === "string" ? supplied.matchToken : undefined;
    const startPayload = (viewer: 0 | 1) => ({
      seed,
      deck: Array.isArray(decks[viewer]) ? decks[viewer] : [],
      ...(matchToken ? { matchToken } : {}),
    });
    room.peers.forEach((other, index) => {
      pvpJson(other, {
        type: "action",
        playerId: peer.id,
        peerName: peer.name,
        sequence,
        action,
        payload: startPayload(index === 0 ? 0 : 1),
      });
    });
    pvpJson(peer, { type: "action_ack", action, sequence });
    return;
  }
  const payload = action === "ready"
    ? { ready: true }
    : action === "command" && rawPayload && !Array.isArray(rawPayload)
    ? {
        ...(rawPayload as Record<string, unknown>),
        command: canonicalCommand(
          (rawPayload as Record<string, unknown>).command,
          room.peers[0] === peer ? 0 : 1,
        ) ?? (rawPayload as Record<string, unknown>).command,
      }
    : rawPayload;
  const recipients = action === "ready" ? room.peers.filter((other) => other !== peer) : room.peers;
  recipients.forEach((other) => pvpJson(other, {
    type: "action",
    playerId: peer.id,
    peerName: peer.name,
    sequence,
    action,
    payload,
  }));
  pvpJson(peer, { type: "action_ack", action, sequence });
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
      createPvpRoom(peer);
      break;
    case "join_room":
      joinPvpRoom(peer, typeof message.room === "string" ? message.room.trim().toUpperCase() : "");
      break;
    case "action":
      relayPvpAction(peer, message);
      break;
    case "sync": {
      const room = peer.room ? pvpRooms.get(peer.room) : null;
      if (room) pvpRoomState(room);
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

async function handlePvpPollMemory(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET") {
    const clientId = url.searchParams.get("clientId") ?? "";
    const peer = pvpPollSessions.get(clientId);
    if (!peer) return pvpJsonResponse({ ok: false, message: "联机会话已过期，请重新连接。" }, 404);
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
      await db.prepare(`UPDATE pvp_sessions SET updated_at = ? WHERE client_id = ?`).bind(Date.now(), clientId).run();
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
      if (session) await dbLeaveRoom(db, session);
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
        if (existing && identityKey && existingIdentity && identityKey !== existingIdentity) {
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
