ALTER TABLE `match_records` ADD `pvp_token` text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `match_records_player_pvp_token_uidx`
ON `match_records` (`player_id`,`pvp_token`) WHERE `pvp_token` IS NOT NULL;
