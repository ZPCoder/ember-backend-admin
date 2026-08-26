-- Hidden skill data is kept outside public player state. IF NOT EXISTS keeps
-- this migration compatible with deployments where the Worker initialized the
-- table during a rolling release before the migration runner reached it.
CREATE TABLE IF NOT EXISTS `pvp_matchmaking_ratings` (
	`identity_key` text NOT NULL,
	`format` text NOT NULL CHECK (`format` IN ('ranked', 'casual')),
	`rating` integer DEFAULT 1500 NOT NULL,
	`games` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`identity_key`, `format`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `pvp_matchmaking_ratings_format_rating_idx`
ON `pvp_matchmaking_ratings` (`format`, `rating`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `pvp_mmr_settlements` (
	`match_token` text PRIMARY KEY NOT NULL,
	`format` text NOT NULL CHECK (`format` IN ('ranked', 'casual')),
	`host_identity` text NOT NULL,
	`guest_identity` text NOT NULL,
	`winner` integer CHECK (`winner` IN (0, 1) OR `winner` IS NULL),
	`host_rating_before` integer NOT NULL,
	`guest_rating_before` integer NOT NULL,
	`host_games_before` integer NOT NULL,
	`guest_games_before` integer NOT NULL,
	`host_rating_after` integer NOT NULL,
	`guest_rating_after` integer NOT NULL,
	`host_games_after` integer NOT NULL,
	`guest_games_after` integer NOT NULL,
	`applied` integer DEFAULT 0 NOT NULL CHECK (`applied` IN (0, 1)),
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `pvp_mmr_settlements_created_idx`
ON `pvp_mmr_settlements` (`created_at`);
