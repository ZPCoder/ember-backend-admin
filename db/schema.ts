import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const players = sqliteTable(
  "players",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    identityKey: text("identity_key"),
    displayName: text("display_name").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("players_email_idx").on(table.email),
    uniqueIndex("players_identity_key_uidx").on(table.identityKey),
  ],
);

export const playerStates = sqliteTable("player_states", {
  playerId: text("player_id")
    .primaryKey()
    .references(() => players.id, { onDelete: "cascade" }),
  stateJson: text("state_json").notNull(),
  version: integer("version").notNull().default(1),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const matchRecords = sqliteTable(
  "match_records",
  {
    id: text("id").primaryKey(),
    playerId: text("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    pvpToken: text("pvp_token"),
    result: text("result", { enum: ["win", "loss"] }).notNull(),
    mode: text("mode", { enum: ["ai", "pvp"] }).notNull(),
    opponent: text("opponent").notNull(),
    rewardGold: integer("reward_gold").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("match_records_player_idempotency_uidx").on(
      table.playerId,
      table.idempotencyKey,
    ),
    uniqueIndex("match_records_player_pvp_token_uidx").on(
      table.playerId,
      table.pvpToken,
    ),
    index("match_records_player_created_idx").on(
      table.playerId,
      table.createdAt,
    ),
  ],
);

export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    playerId: text("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    idempotencyKey: text("idempotency_key"),
    payloadJson: text("payload_json").notNull(),
    resultJson: text("result_json").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("audit_events_player_idempotency_uidx").on(
      table.playerId,
      table.idempotencyKey,
    ),
    index("audit_events_player_created_idx").on(
      table.playerId,
      table.createdAt,
    ),
  ],
);

// These snapshots are written by the PVP Worker and read by the game API when
// a client submits a result. Keeping them in the shared schema makes the
// runtime-created tables visible to D1 migrations as well.
export const pvpMatches = sqliteTable(
  "pvp_matches",
  {
    roomCode: text("room_code").primaryKey(),
    matchToken: text("match_token").notNull(),
    stateJson: text("state_json").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [uniqueIndex("pvp_matches_token_uidx").on(table.matchToken)],
);

export const pvpMatchParticipants = sqliteTable(
  "pvp_match_participants",
  {
    matchToken: text("match_token").primaryKey(),
    roomCode: text("room_code").notNull(),
    hostIdentity: text("host_identity").notNull(),
    guestIdentity: text("guest_identity").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("pvp_match_participants_created_idx").on(table.createdAt)],
);
