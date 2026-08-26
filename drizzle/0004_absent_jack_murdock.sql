CREATE TABLE `pvp_format_matchmaking_ratings` (
	`identity_key` text NOT NULL,
	`mode` text NOT NULL,
	`rating_pool` text NOT NULL,
	`rating` integer DEFAULT 1500 NOT NULL,
	`games` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`identity_key`, `mode`, `rating_pool`)
);
--> statement-breakpoint
CREATE INDEX `pvp_format_ratings_pool_rating_idx` ON `pvp_format_matchmaking_ratings` (`mode`,`rating_pool`,`rating`);--> statement-breakpoint
CREATE TABLE `pvp_format_mmr_settlements` (
	`match_token` text PRIMARY KEY NOT NULL,
	`mode` text NOT NULL,
	`rating_pool` text NOT NULL,
	`host_identity` text NOT NULL,
	`guest_identity` text NOT NULL,
	`winner` integer,
	`host_rating_before` integer NOT NULL,
	`guest_rating_before` integer NOT NULL,
	`host_games_before` integer NOT NULL,
	`guest_games_before` integer NOT NULL,
	`host_rating_after` integer NOT NULL,
	`guest_rating_after` integer NOT NULL,
	`host_games_after` integer NOT NULL,
	`guest_games_after` integer NOT NULL,
	`applied` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pvp_format_mmr_settlements_created_idx` ON `pvp_format_mmr_settlements` (`created_at`);--> statement-breakpoint
ALTER TABLE `match_records` ADD `ranked_format` text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE `pvp_match_archives` ADD `ranked_format` text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE `pvp_matches` ADD `ranked_format` text DEFAULT 'standard' NOT NULL;