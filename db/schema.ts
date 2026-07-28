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
    displayName: text("display_name").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [uniqueIndex("players_email_uidx").on(table.email)],
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
