/** Cloudflare Worker entry point for 余烬协议. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

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

const PVP_SESSION_TTL_MS = 30 * 60 * 1000;

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

async function getPvpDbRoom(db: PvpDatabase, code: string): Promise<PvpDbRoom | null> {
  return db.prepare(`SELECT code, host_client_id, guest_client_id, next_sequence FROM pvp_rooms WHERE code = ?`)
    .bind(code).first<PvpDbRoom>();
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
}

async function dbLeaveRoom(db: PvpDatabase, session: PvpDbSession): Promise<void> {
  if (!session.room_code) return;
  const room = await getPvpDbRoom(db, session.room_code);
  if (!room) {
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
    await db.prepare(`UPDATE pvp_sessions SET room_code = ? WHERE client_id = ?`).bind(room.code, opponentId).run();
    const remaining = await getPvpDbRoom(db, room.code);
    if (remaining) await dbRoomState(db, remaining);
  } else {
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
    await queuePvpDbMessage(db, session.client_id, { type: "room_joined", room: code, message: "已恢复房间连接" });
    await dbRoomState(db, room);
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
  if (host) await db.prepare(`UPDATE pvp_sessions SET updated_at = ? WHERE client_id = ?`).bind(now, host.client_id).run();
  await dbRoomState(db, updated);
}

async function dbRelayAction(db: PvpDatabase, session: PvpDbSession, message: PvpMessage): Promise<void> {
  const room = session.room_code ? await getPvpDbRoom(db, session.room_code) : null;
  if (!room) return queuePvpDbMessage(db, session.client_id, { type: "error", message: "请先创建或加入房间" });
  const action = typeof message.action === "string" ? message.action : "";
  if (!["ready", "match_start", "command"].includes(action)) return queuePvpDbMessage(db, session.client_id, { type: "error", message: "联机指令类型无效" });
  const payload = message.payload && typeof message.payload === "object" ? message.payload : {};
  await db.prepare(`UPDATE pvp_rooms SET next_sequence = next_sequence + 1, updated_at = ? WHERE code = ?`).bind(Date.now(), room.code).run();
  const updated = await getPvpDbRoom(db, room.code);
  const sequence = updated?.next_sequence ?? room.next_sequence + 1;
  const opponentId = room.host_client_id === session.client_id ? room.guest_client_id : room.host_client_id;
  if (opponentId) await queuePvpDbMessage(db, opponentId, { type: "action", playerId: session.player_id, peerName: session.name, sequence, action, payload });
  await queuePvpDbMessage(db, session.client_id, { type: "action_ack", action, sequence });
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
  room.peers.filter((other) => other !== peer).forEach((other) => pvpJson(other, {
    type: "peer_joined",
    peerName: peer.name,
    playerId: peer.id,
    message: `${peer.name} 已加入房间`,
  }));
  pvpRoomState(room);
}

function relayPvpAction(peer: PvpPeer, message: PvpMessage): void {
  const room = peer.room ? pvpRooms.get(peer.room) : null;
  if (!room) return pvpError(peer, "请先创建或加入房间");
  const action = typeof message.action === "string" ? message.action : "";
  if (!["ready", "match_start", "command"].includes(action)) {
    return pvpError(peer, "联机指令类型无效");
  }
  const payload = message.payload && typeof message.payload === "object" ? message.payload : {};
  const sequence = ++room.nextSequence;
  room.peers.filter((other) => other !== peer).forEach((other) => pvpJson(other, {
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
      await db.prepare(`DELETE FROM pvp_sessions WHERE client_id = ?`).bind(clientId).run();
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
      const now = Date.now();
      const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 24) : "旅者";
      const requestedClientId = typeof body.clientId === "string" && /^[A-Za-z0-9_-]{8,96}$/.test(body.clientId)
        ? body.clientId
        : "";
      // A browser refresh should reattach to its short-lived session instead of
      // creating a second player and orphaning the room. Expired sessions are
      // discarded so a stale tab cannot reclaim a room indefinitely.
      if (requestedClientId) {
        const existing = await getPvpDbSession(db, requestedClientId);
        if (existing && now - Number(existing.updated_at || 0) <= PVP_SESSION_TTL_MS) {
          await db.prepare(`UPDATE pvp_sessions SET name = ?, updated_at = ? WHERE client_id = ?`)
            .bind(name, now, requestedClientId).run();
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
          await db.prepare(`DELETE FROM pvp_sessions WHERE client_id = ?`).bind(requestedClientId).run();
        }
      }
      const clientId = requestedClientId || `poll-${crypto.randomUUID()}`;
      const playerId = `p-${crypto.randomUUID()}`;
      await db.prepare(`INSERT INTO pvp_sessions (client_id, player_id, name, room_code, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)`)
        .bind(clientId, playerId, name, now, now).run();
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
