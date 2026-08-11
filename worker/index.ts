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

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

type PvpMessage = Record<string, unknown>;
type PvpPeer = { socket: WebSocket; id: string; name: string; room: string | null };
type PvpRoom = { code: string; peers: PvpPeer[] };

const pvpRooms = new Map<string, PvpRoom>();
const pvpPeers = new Map<WebSocket, PvpPeer>();
const pvpAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ";

function pvpJson(peer: PvpPeer, message: PvpMessage): void {
  try {
    peer.socket.send(JSON.stringify(message));
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
  if (!pvpPeers.has(peer.socket)) return;
  pvpPeers.delete(peer.socket);
  leavePvpRoom(peer);
}

function createPvpRoom(peer: PvpPeer): void {
  leavePvpRoom(peer);
  let code = "";
  do {
    code = Array.from({ length: 4 }, () => pvpAlphabet[Math.floor(Math.random() * pvpAlphabet.length)]).join("");
  } while (pvpRooms.has(code));
  const room: PvpRoom = { code, peers: [peer] };
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
  room.peers.filter((other) => other !== peer).forEach((other) => pvpJson(other, {
    type: "action",
    playerId: peer.id,
    peerName: peer.name,
    action: message.action,
    payload: message.payload && typeof message.payload === "object" ? message.payload : {},
  }));
  pvpJson(peer, { type: "action_ack", action: message.action });
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

    return handler.fetch(request, env, ctx);
  },
};

export default worker;
