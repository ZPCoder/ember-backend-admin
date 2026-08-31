import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  AdminService,
  ApiRouter,
  AuthService,
  ChannelRegistry,
  D1SchemaReadiness,
  MemoryBackendStore,
  Platform4399Adapter,
  PlayerService,
  PollingPvpTransport,
  PvpService,
  ServiceError,
  SetCardCatalog,
  StaticSchemaReadiness,
  WebSocketPvpTransport,
  type AdminAuthenticator,
  type ApiRequest,
  type Clock,
  type LegacyFlutterSaveV1,
  type Platform4399Gateway,
} from "../src/index.ts";

class FixedClock implements Clock {
  private value = new Date("2026-08-31T00:00:00.000Z");

  now(): Date {
    return new Date(this.value);
  }

  advance(milliseconds: number): void {
    this.value = new Date(this.value.getTime() + milliseconds);
  }
}

class Fake4399Gateway implements Platform4399Gateway {
  calls: string[] = [];

  async exchangeTicket(ticket: string) {
    this.calls.push(ticket);
    return { subject: `verified:${ticket}`, displayName: "测试指挥官" };
  }

  async containsSensitiveWords(text: string): Promise<boolean> {
    return text.includes("禁词");
  }

  async queryRole(subject: string): Promise<Record<string, string>> {
    return { subject };
  }

  async claimGift(): Promise<{ claimed: boolean }> {
    return { claimed: true };
  }
}

const cards = new SetCardCatalog(["card-a", "card-b", "card-c"]);
const pvpFixtureBytes = readFileSync(new URL("./fixtures/pvp-event-envelope-1.0.json", import.meta.url));
const pvpFixture = JSON.parse(pvpFixtureBytes.toString("utf8")) as Record<string, unknown>;

function fixture(readiness = new StaticSchemaReadiness()) {
  const store = new MemoryBackendStore();
  const clock = new FixedClock();
  const gateway = new Fake4399Gateway();
  const channels = new ChannelRegistry([new Platform4399Adapter(gateway)]);
  const auth = new AuthService(store, channels, clock);
  const players = new PlayerService(store, channels, cards);
  const pvp = new PvpService(store, clock);
  const admin = new AdminService(store, cards, clock);
  const adminAuthenticator: AdminAuthenticator = {
    async authenticate() {
      return { adminId: "admin-1", roles: ["superadmin"] };
    },
  };
  const router = new ApiRouter(
    { readiness, auth, players, pvp, admin, adminAuthenticator },
    { allowedOrigins: ["https://game.example"], frameAncestors: ["https://game.example", "https://*.4399.com"] },
  );
  return { store, clock, gateway, auth, players, pvp, admin, router };
}

async function login(instance: ReturnType<typeof fixture>, ticket = "ticket-0001") {
  return instance.auth.exchange({ platform: "4399", ticket, clientVersion: "0.1.0", protocolVersion: "1.0" });
}

function legacySave(overrides: Partial<LegacyFlutterSaveV1> = {}): LegacyFlutterSaveV1 {
  return {
    schemaVersion: 1,
    commanderName: "旧指挥官",
    collection: { "card-a": 2, "card-b": 1 },
    gold: 100,
    dust: 25,
    packs: { core: 3 },
    decks: [{ slot: 0, name: "旧牌组", format: "standard", deckCode: "abc", cardIds: ["card-a", "card-b"] }],
    format: "standard",
    record: { wins: 4, losses: 2, draws: 1 },
    ...overrides,
  };
}

test("4399 tickets are verified server-side, are single-use, and produce short sessions", async () => {
  const instance = fixture();
  const response = await login(instance);
  assert.equal(instance.gateway.calls.length, 1);
  assert.equal(response.player.displayName, "测试指挥官");
  assert.equal(response.protocolVersion, "1.0");
  assert.equal(response.configVersion, "1.0.0");
  assert.match(response.accessToken, /^ep_[0-9a-f]{64}$/);
  assert.equal((await instance.auth.authenticate(response.accessToken)).playerId, response.player.id);

  await assert.rejects(
    instance.auth.exchange({
      platform: "4399",
      ticket: "ticket-forged-uid",
      clientVersion: "0.1.0",
      protocolVersion: "1.0",
      uid: "forged-browser-uid",
    } as never),
    (error: unknown) => error instanceof ServiceError && error.code === "INVALID_CHANNEL_LOGIN",
  );
  assert.equal(instance.gateway.calls.length, 1, "forged UID must be rejected before the 4399 gateway");

  await assert.rejects(
    instance.auth.exchange({
      platform: "4399",
      ticket: "ticket-newer-protocol",
      clientVersion: "0.1.0",
      protocolVersion: "1.1",
    }),
    (error: unknown) => error instanceof ServiceError && error.code === "CLIENT_VERSION_UNSUPPORTED",
  );
  assert.equal(instance.gateway.calls.length, 1, "unsupported protocol must be rejected before ticket exchange");

  await assert.rejects(
    login(instance),
    (error: unknown) => error instanceof ServiceError && error.code === "CHANNEL_TICKET_REPLAY",
  );
  instance.clock.advance(15 * 60 * 1000);
  await assert.rejects(
    instance.auth.authenticate(response.accessToken),
    (error: unknown) => error instanceof ServiceError && error.code === "SESSION_EXPIRED",
  );
});

test("player commands enforce expectedVersion and idempotency content", async () => {
  const instance = fixture();
  const loginResponse = await login(instance);
  const principal = await instance.auth.authenticate(loginResponse.accessToken);
  const envelope = {
    protocolVersion: "1.0",
    requestId: "request-1",
    idempotencyKey: "idem-player-1",
    expectedVersion: 1,
    command: { type: "set-commander-name" as const, commanderName: "余烬" },
  };
  const first = await instance.players.command(principal, envelope);
  const repeated = await instance.players.command(principal, envelope);
  assert.equal(first.version, 2);
  assert.deepEqual(repeated, first);

  await assert.rejects(
    instance.players.command(principal, { ...envelope, command: { type: "set-commander-name", commanderName: "另一个名字" } }),
    (error: unknown) => error instanceof ServiceError && error.code === "IDEMPOTENCY_KEY_REUSED",
  );
  await assert.rejects(
    instance.players.command(principal, { ...envelope, idempotencyKey: "idem-player-2" }),
    (error: unknown) => error instanceof ServiceError && error.code === "STALE_PLAYER_VERSION",
  );
});

test("polling and WebSocket deliver the same authoritative PVP event envelope", async () => {
  const instance = fixture();
  const loginResponse = await login(instance);
  const principal = await instance.auth.authenticate(loginResponse.accessToken);
  const session = await instance.pvp.createSession(principal, {
    protocolVersion: "1.0",
    requestId: "pvp-create-1",
    idempotencyKey: "pvp-create-idem-1",
    format: "standard",
    deckId: "deck-1",
  });
  await instance.pvp.command(principal, session.matchId, {
    protocolVersion: "1.0",
    requestId: "pvp-command-1",
    idempotencyKey: "pvp-command-idem-1",
    expectedVersion: 0,
    command: { type: "play-card", player: 0, cardId: "secret-hand-card", handIndex: 0 },
  });
  const polling = await new PollingPvpTransport(instance.pvp).poll(principal, session.matchId, 0);
  const sent: string[] = [];
  const cursor = await new WebSocketPvpTransport(instance.pvp).flush(
    { send(payload) { sent.push(payload); } },
    principal,
    session.matchId,
    0,
  );
  assert.equal(cursor, 1);
  assert.deepEqual(JSON.parse(sent[0]!), polling);
  assert.deepEqual(Object.keys(polling).sort(), Object.keys(pvpFixture).sort());
  assert.equal(polling.events[0]?.type, "command-accepted");
  assert.equal(polling.snapshot?.opponent.handCount, 0);
  assert.equal(Object.hasOwn(polling.snapshot?.opponent ?? {}, "hand"), false);
  assert.equal(JSON.stringify(polling).includes("secret-hand-card"), false);
});

test("pins the same canonical PVP fixture as ember-protocol", () => {
  assert.equal(
    createHash("sha256").update(pvpFixtureBytes).digest("hex"),
    "29cc406cc852da94a71bf6d6a4d834af6faa4528f38c6652a09d73792368c684",
  );
  const snapshot = pvpFixture.snapshot as { opponent: Record<string, unknown> };
  assert.equal(Object.hasOwn(snapshot.opponent, "hand"), false);
});

test("legacy import validates assets, requires typed confirmation, audits, and rolls back safely", async () => {
  const instance = fixture();
  const loginResponse = await login(instance);
  const principal = { adminId: "admin-1", roles: ["superadmin"] };
  const request = {
    migrationId: "migration_test_0001",
    playerId: loginResponse.player.id,
    save: legacySave(),
    requestId: "admin-preview-1",
    confirmation: { confirmed: true as const, confirmationText: "PREVIEW migration_test_0001" },
  };
  const preview = await instance.admin.previewLegacyMigration(principal, request);
  assert.equal(preview.valid, true);
  assert.deepEqual(await instance.admin.previewLegacyMigration(principal, request), preview);
  assert.deepEqual((await instance.admin.listAudit(principal)).map((entry) => entry.action), ["legacy-save.preview"]);
  await assert.rejects(
    instance.admin.applyLegacyMigration(principal, preview.migrationId, "admin-apply-1", {
      confirmed: true,
      confirmationText: "wrong",
    }),
    (error: unknown) => error instanceof ServiceError && error.code === "ADMIN_CONFIRMATION_REQUIRED",
  );
  const applied = await instance.admin.applyLegacyMigration(principal, preview.migrationId, "admin-apply-1", {
    confirmed: true,
    confirmationText: `APPLY ${preview.migrationId}`,
  });
  assert.equal(applied.gold, 100);
  assert.equal(applied.version, 2);
  assert.deepEqual(
    await instance.admin.applyLegacyMigration(principal, preview.migrationId, "admin-apply-repeat", {
      confirmed: true,
      confirmationText: `APPLY ${preview.migrationId}`,
    }),
    applied,
  );
  const rolledBack = await instance.admin.rollbackLegacyMigration(principal, preview.migrationId, "admin-rollback-1", {
    confirmed: true,
    confirmationText: `ROLLBACK ${preview.migrationId}`,
  });
  assert.equal(rolledBack.gold, 0);
  assert.equal(rolledBack.version, 3);
  assert.deepEqual((await instance.admin.listAudit(principal)).map((entry) => entry.action), [
    "legacy-save.rollback",
    "legacy-save.apply",
    "legacy-save.preview",
  ]);
});

test("invalid and stale legacy saves cannot be applied or automatically rolled back", async () => {
  const instance = fixture();
  const loginResponse = await login(instance);
  const admin = { adminId: "admin-1", roles: ["superadmin"] };
  const invalid = await instance.admin.previewLegacyMigration(admin, {
    migrationId: "migration_invalid_1",
    playerId: loginResponse.player.id,
    save: legacySave({ gold: -1, packs: { core: -1 }, collection: { unknown: 1 } }),
    requestId: "preview-invalid",
    confirmation: { confirmed: true, confirmationText: "PREVIEW migration_invalid_1" },
  });
  assert.equal(invalid.valid, false);
  assert.match(invalid.errors.join(" "), /unknown card/);
  assert.match(invalid.errors.join(" "), /packs\.core/);
  await assert.rejects(
    instance.admin.applyLegacyMigration(admin, invalid.migrationId, "apply-invalid", {
      confirmed: true,
      confirmationText: `APPLY ${invalid.migrationId}`,
    }),
    (error: unknown) => error instanceof ServiceError && error.code === "INVALID_LEGACY_SAVE",
  );

  const preview = await instance.admin.previewLegacyMigration(admin, {
    migrationId: "migration_conflict_1",
    playerId: loginResponse.player.id,
    save: legacySave(),
    requestId: "preview-conflict",
    confirmation: { confirmed: true, confirmationText: "PREVIEW migration_conflict_1" },
  });
  const applied = await instance.admin.applyLegacyMigration(admin, preview.migrationId, "apply-conflict", {
    confirmed: true,
    confirmationText: `APPLY ${preview.migrationId}`,
  });
  const playerPrincipal = await instance.auth.authenticate(loginResponse.accessToken);
  await instance.players.command(playerPrincipal, {
    protocolVersion: "1.0",
    requestId: "post-migration-change",
    idempotencyKey: "post-migration-idem",
    expectedVersion: applied.version,
    command: { type: "set-commander-name", commanderName: "新名字" },
  });
  await assert.rejects(
    instance.admin.rollbackLegacyMigration(admin, preview.migrationId, "rollback-conflict", {
      confirmed: true,
      confirmationText: `ROLLBACK ${preview.migrationId}`,
    }),
    (error: unknown) => error instanceof ServiceError && error.code === "ROLLBACK_VERSION_CONFLICT",
  );
});

test("router returns 503 before migration, enforces CORS, and exposes the requested v1 flow", async () => {
  const unavailable = fixture(new StaticSchemaReadiness(false));
  const blocked = await unavailable.router.handle({ method: "GET", url: "/v1/player" });
  assert.equal(blocked.status, 503);
  assert.equal((blocked.body as { code: string }).code, "SERVICE_UNAVAILABLE");
  assert.match((blocked.body as { requestId: string }).requestId, /^request_/);

  const instance = fixture();
  const denied = await instance.router.handle({
    method: "POST",
    url: "/v1/auth/channel/exchange",
    headers: { origin: "https://evil.example" },
    body: { platform: "4399", ticket: "ticket-router-1", clientVersion: "0.1.0", protocolVersion: "1.0" },
  });
  assert.equal(denied.status, 403);
  const exchanged = await instance.router.handle({
    method: "POST",
    url: "/v1/auth/channel/exchange",
    headers: { origin: "https://game.example" },
    body: { platform: "4399", ticket: "ticket-router-2", clientVersion: "0.1.0", protocolVersion: "1.0" },
  });
  assert.equal(exchanged.status, 200);
  const token = (exchanged.body as { accessToken: string }).accessToken;
  const player = await instance.router.handle({
    method: "GET",
    url: "/v1/player",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(player.status, 200);

  const created = await instance.router.handle({
    method: "POST",
    url: "/v1/pvp/sessions",
    headers: {
      authorization: `Bearer ${token}`,
      "idempotency-key": "router-pvp-create-idem",
      "x-request-id": "router-pvp-create-request",
    },
    body: { protocolVersion: "1.0", format: "standard", deckId: "deck-1" },
  });
  assert.equal(created.status, 201);
  const matchId = (created.body as { matchId: string }).matchId;
  assert.match(matchId, /^match_/);

  const accepted = await instance.router.handle({
    method: "POST",
    url: `/v1/pvp/commands?matchId=${encodeURIComponent(matchId)}`,
    headers: {
      authorization: `Bearer ${token}`,
      "idempotency-key": "router-pvp-command-idem",
    },
    body: {
      protocolVersion: "1.0",
      requestId: "router-pvp-command-request",
      idempotencyKey: "router-pvp-command-idem",
      expectedVersion: 0,
      command: { type: "end-turn", player: 0, reason: "manual" },
    },
  });
  assert.equal(accepted.status, 202);

  const events = await instance.router.handle({
    method: "GET",
    url: `/v1/pvp/events?matchId=${encodeURIComponent(matchId)}&after=0`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(events.status, 200);
  assert.equal((events.body as { matchId: string }).matchId, matchId);
  assert.equal((events.body as { events: unknown[] }).events.length, 1);
});

test("D1 readiness is a read-only assertion and application sources contain no runtime DDL", async () => {
  const prepared: string[] = [];
  const readiness = new D1SchemaReadiness({
    prepare(sql: string) {
      prepared.push(sql);
      return {
        bind() { return this; },
        async first<T>() { return { value: "1" } as T; },
      };
    },
  });
  assert.equal((await readiness.status()).ready, true);
  assert.deepEqual(prepared, ["SELECT value FROM schema_metadata WHERE key = ? LIMIT 1"]);

  const sourceDirectory = new URL("../src", import.meta.url).pathname;
  for (const file of readdirSync(sourceDirectory).filter((name) => name.endsWith(".ts"))) {
    const source = readFileSync(join(sourceDirectory, file), "utf8");
    assert.doesNotMatch(source, /\b(?:CREATE|ALTER|DROP)\s+TABLE\b/i, `runtime DDL found in ${file}`);
  }
});

test("canonical 0000 creates every authoritative domain with uniqueness and version guards", () => {
  const sql = readFileSync(new URL("../migrations/canonical/0000_canonical.sql", import.meta.url), "utf8");
  for (const table of [
    "players",
    "player_wallets",
    "player_cards",
    "decks",
    "platform_accounts",
    "sessions",
    "friendships",
    "matches",
    "match_commands",
    "match_events",
    "pvp_queue",
    "legacy_save_imports",
    "game_events",
    "admin_audit_log",
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE ${table}\\b`));
  }
  assert.match(sql, /UNIQUE \(match_id, player_id, idempotency_key\)/);
  assert.match(sql, /expected_version INTEGER NOT NULL/);
  assert.match(sql, /token_hash TEXT NOT NULL UNIQUE/);
  assert.match(sql, /UNIQUE \(player_id, source_sha256\)/);
  assert.match(sql, /ranked_format TEXT NOT NULL DEFAULT 'standard'/);
  assert.match(sql, /quantity BETWEEN 0 AND 999/);
});
