PRAGMA foreign_keys = ON;

CREATE TABLE schema_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE players (
  id TEXT PRIMARY KEY,
  commander_name TEXT NOT NULL CHECK (length(commander_name) BETWEEN 1 AND 64),
  ranked_format TEXT NOT NULL DEFAULT 'standard' CHECK (ranked_format IN ('standard', 'wild')),
  account_status TEXT NOT NULL DEFAULT 'active' CHECK (account_status IN ('active', 'suspended', 'deleted')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX players_commander_name_idx ON players(commander_name);
CREATE INDEX players_status_updated_idx ON players(account_status, updated_at);

CREATE TABLE player_wallets (
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  currency TEXT NOT NULL CHECK (currency IN ('gold', 'dust')),
  amount INTEGER NOT NULL DEFAULT 0 CHECK (amount BETWEEN 0 AND 1000000000),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (player_id, currency)
);

CREATE TABLE player_packs (
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  pack_id TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity BETWEEN 0 AND 1000000),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (player_id, pack_id)
);

CREATE TABLE player_cards (
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  card_id TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity BETWEEN 0 AND 999),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (player_id, card_id)
);

CREATE INDEX player_cards_card_idx ON player_cards(card_id, player_id);

CREATE TABLE decks (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  slot INTEGER NOT NULL CHECK (slot BETWEEN 0 AND 26),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
  format TEXT NOT NULL CHECK (format IN ('standard', 'wild')),
  deck_code TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (player_id, slot)
);

CREATE INDEX decks_player_format_idx ON decks(player_id, format);

CREATE TABLE deck_cards (
  deck_id TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 59),
  card_id TEXT NOT NULL,
  PRIMARY KEY (deck_id, position)
);

CREATE INDEX deck_cards_card_idx ON deck_cards(card_id);

CREATE TABLE player_stats (
  player_id TEXT PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  wins INTEGER NOT NULL DEFAULT 0 CHECK (wins BETWEEN 0 AND 1000000000),
  losses INTEGER NOT NULL DEFAULT 0 CHECK (losses BETWEEN 0 AND 1000000000),
  draws INTEGER NOT NULL DEFAULT 0 CHECK (draws BETWEEN 0 AND 1000000000),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at TEXT NOT NULL
);

CREATE TABLE platform_accounts (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL,
  provider_subject TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'unlinked', 'blocked')),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  linked_by_admin_id TEXT,
  linked_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (provider, provider_subject)
);

CREATE INDEX platform_accounts_player_provider_idx ON platform_accounts(player_id, provider);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  platform_account_id TEXT REFERENCES platform_accounts(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  channel_ticket_hash TEXT NOT NULL UNIQUE CHECK (length(channel_ticket_hash) = 64),
  client_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT,
  revoke_reason TEXT
);

CREATE INDEX sessions_player_expiry_idx ON sessions(player_id, expires_at);
CREATE INDEX sessions_expiry_active_idx ON sessions(expires_at, revoked_at);

CREATE TABLE idempotency_records (
  scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  response_status INTEGER NOT NULL,
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  resulting_version INTEGER,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (scope, idempotency_key)
);

CREATE INDEX idempotency_expiry_idx ON idempotency_records(expires_at);

CREATE TABLE friend_requests (
  id TEXT PRIMARY KEY,
  sender_player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  receiver_player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled')),
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  CHECK (sender_player_id <> receiver_player_id),
  UNIQUE (sender_player_id, idempotency_key)
);

CREATE INDEX friend_requests_receiver_status_idx ON friend_requests(receiver_player_id, status, created_at);

CREATE TABLE friendships (
  lower_player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  upper_player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  CHECK (lower_player_id < upper_player_id),
  PRIMARY KEY (lower_player_id, upper_player_id)
);

CREATE INDEX friendships_upper_idx ON friendships(upper_player_id, lower_player_id);

CREATE TABLE player_blocks (
  blocker_player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  blocked_player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  CHECK (blocker_player_id <> blocked_player_id),
  PRIMARY KEY (blocker_player_id, blocked_player_id)
);

CREATE INDEX player_blocks_blocked_idx ON player_blocks(blocked_player_id);

CREATE TABLE social_conversations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('direct', 'party', 'system')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE social_conversation_members (
  conversation_id TEXT NOT NULL REFERENCES social_conversations(id) ON DELETE CASCADE,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  joined_at TEXT NOT NULL,
  left_at TEXT,
  PRIMARY KEY (conversation_id, player_id)
);

CREATE INDEX social_members_player_idx ON social_conversation_members(player_id, left_at);

CREATE TABLE social_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES social_conversations(id) ON DELETE CASCADE,
  sender_player_id TEXT REFERENCES players(id) ON DELETE SET NULL,
  channel_message_id TEXT,
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 500),
  moderation_status TEXT NOT NULL DEFAULT 'accepted' CHECK (moderation_status IN ('accepted', 'rejected', 'review')),
  created_at TEXT NOT NULL,
  UNIQUE (conversation_id, channel_message_id)
);

CREATE INDEX social_messages_conversation_time_idx ON social_messages(conversation_id, created_at);

CREATE TABLE social_reports (
  id TEXT PRIMARY KEY,
  reporter_player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  target_player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  message_id TEXT REFERENCES social_messages(id) ON DELETE SET NULL,
  reason_code TEXT NOT NULL,
  detail TEXT CHECK (detail IS NULL OR length(detail) <= 500),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewing', 'resolved', 'dismissed')),
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by_admin_id TEXT REFERENCES admin_users(id) ON DELETE SET NULL,
  CHECK (reporter_player_id <> target_player_id)
);

CREATE INDEX social_reports_reporter_time_idx ON social_reports(reporter_player_id, created_at);
CREATE INDEX social_reports_target_time_idx ON social_reports(target_player_id, created_at);
CREATE INDEX social_reports_status_time_idx ON social_reports(status, created_at);

CREATE TABLE matches (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('ranked', 'casual', 'ai')),
  rules_version TEXT NOT NULL,
  config_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('waiting', 'active', 'finished', 'cancelled', 'expired')),
  state_version INTEGER NOT NULL DEFAULT 0 CHECK (state_version >= 0),
  last_cursor INTEGER NOT NULL DEFAULT 0 CHECK (last_cursor >= 0),
  winner_player_id TEXT REFERENCES players(id) ON DELETE SET NULL,
  result_reason TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  expires_at TEXT NOT NULL
);

CREATE INDEX matches_status_expiry_idx ON matches(status, expires_at);
CREATE INDEX matches_created_idx ON matches(created_at);

CREATE TABLE match_participants (
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  seat INTEGER NOT NULL CHECK (seat BETWEEN 0 AND 1),
  player_id TEXT REFERENCES players(id) ON DELETE RESTRICT,
  legacy_identity_key TEXT,
  deck_snapshot_json TEXT NOT NULL CHECK (json_valid(deck_snapshot_json)),
  joined_at TEXT NOT NULL,
  last_ack_cursor INTEGER NOT NULL DEFAULT 0 CHECK (last_ack_cursor >= 0),
  disconnected_at TEXT,
  conceded_at TEXT,
  CHECK (player_id IS NOT NULL OR legacy_identity_key IS NOT NULL),
  PRIMARY KEY (match_id, seat),
  UNIQUE (match_id, player_id)
);

CREATE INDEX match_participants_player_idx ON match_participants(player_id, joined_at);
CREATE INDEX match_participants_legacy_idx ON match_participants(legacy_identity_key, joined_at);

CREATE TABLE match_commands (
  id TEXT PRIMARY KEY,
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  request_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  expected_version INTEGER NOT NULL CHECK (expected_version >= 0),
  command_type TEXT NOT NULL,
  command_json TEXT NOT NULL CHECK (json_valid(command_json)),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  status TEXT NOT NULL CHECK (status IN ('accepted', 'rejected')),
  rejection_code TEXT,
  resulting_version INTEGER,
  received_at TEXT NOT NULL,
  processed_at TEXT NOT NULL,
  UNIQUE (match_id, player_id, idempotency_key),
  UNIQUE (match_id, request_id)
);

CREATE INDEX match_commands_match_version_idx ON match_commands(match_id, expected_version, received_at);

CREATE TABLE match_events (
  id TEXT PRIMARY KEY,
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  cursor INTEGER NOT NULL CHECK (cursor > 0),
  state_version INTEGER NOT NULL CHECK (state_version >= 0),
  event_type TEXT NOT NULL,
  public_event_json TEXT NOT NULL CHECK (json_valid(public_event_json)),
  player_0_event_json TEXT CHECK (player_0_event_json IS NULL OR json_valid(player_0_event_json)),
  player_1_event_json TEXT CHECK (player_1_event_json IS NULL OR json_valid(player_1_event_json)),
  occurred_at TEXT NOT NULL,
  UNIQUE (match_id, cursor)
);

CREATE INDEX match_events_match_version_idx ON match_events(match_id, state_version, cursor);

CREATE TABLE match_snapshots (
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  viewer_seat INTEGER NOT NULL CHECK (viewer_seat BETWEEN 0 AND 1),
  state_version INTEGER NOT NULL CHECK (state_version >= 0),
  cursor INTEGER NOT NULL CHECK (cursor >= 0),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  state_hash TEXT NOT NULL CHECK (length(state_hash) = 64),
  created_at TEXT NOT NULL,
  PRIMARY KEY (match_id, viewer_seat, state_version)
);

CREATE TABLE match_settlements (
  id TEXT PRIMARY KEY,
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE RESTRICT,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  before_player_version INTEGER NOT NULL CHECK (before_player_version >= 1),
  after_player_version INTEGER NOT NULL CHECK (after_player_version > before_player_version),
  reward_json TEXT NOT NULL CHECK (json_valid(reward_json)),
  settled_at TEXT NOT NULL,
  UNIQUE (match_id, player_id),
  UNIQUE (player_id, idempotency_key)
);

CREATE TABLE match_archives (
  match_id TEXT PRIMARY KEY REFERENCES matches(id) ON DELETE RESTRICT,
  command_log_json TEXT NOT NULL CHECK (json_valid(command_log_json)),
  event_log_json TEXT NOT NULL CHECK (json_valid(event_log_json)),
  final_state_hash TEXT NOT NULL CHECK (length(final_state_hash) = 64),
  archived_at TEXT NOT NULL
);

CREATE TABLE pvp_queue (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('ranked', 'casual')),
  region TEXT NOT NULL,
  mmr INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'matched', 'cancelled', 'expired')),
  idempotency_key TEXT NOT NULL,
  match_id TEXT REFERENCES matches(id) ON DELETE SET NULL,
  enqueued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE (player_id, idempotency_key)
);

CREATE INDEX pvp_queue_matchmaking_idx ON pvp_queue(status, mode, region, mmr, enqueued_at);
CREATE INDEX pvp_queue_expiry_idx ON pvp_queue(status, expires_at);

CREATE TABLE player_mmr (
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  season_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('ranked', 'casual')),
  rating INTEGER NOT NULL DEFAULT 1000,
  games_played INTEGER NOT NULL DEFAULT 0 CHECK (games_played >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (player_id, season_id, mode)
);

CREATE INDEX player_mmr_leaderboard_idx ON player_mmr(season_id, mode, rating DESC);

CREATE TABLE legacy_identity_links (
  provider TEXT NOT NULL,
  legacy_identity_key TEXT NOT NULL,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  valid_until TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (provider, legacy_identity_key)
);

CREATE INDEX legacy_identity_player_idx ON legacy_identity_links(player_id, valid_until);

CREATE TABLE admin_users (
  id TEXT PRIMARY KEY,
  external_subject TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE admin_user_roles (
  admin_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  granted_by_admin_id TEXT REFERENCES admin_users(id) ON DELETE SET NULL,
  granted_at TEXT NOT NULL,
  PRIMARY KEY (admin_id, role)
);

CREATE TABLE legacy_save_imports (
  migration_id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  source_format TEXT NOT NULL CHECK (source_format = 'LegacyFlutterSaveV1'),
  source_sha256 TEXT NOT NULL CHECK (length(source_sha256) = 64),
  source_json TEXT NOT NULL CHECK (json_valid(source_json)),
  preview_json TEXT NOT NULL CHECK (json_valid(preview_json)),
  before_player_json TEXT CHECK (before_player_json IS NULL OR json_valid(before_player_json)),
  after_player_json TEXT CHECK (after_player_json IS NULL OR json_valid(after_player_json)),
  preview_player_version INTEGER NOT NULL CHECK (preview_player_version >= 1),
  applied_player_version INTEGER,
  status TEXT NOT NULL CHECK (status IN ('previewed', 'rejected', 'applied', 'rolled_back', 'manual_review')),
  created_by_admin_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE RESTRICT,
  applied_by_admin_id TEXT REFERENCES admin_users(id) ON DELETE RESTRICT,
  rolled_back_by_admin_id TEXT REFERENCES admin_users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  applied_at TEXT,
  rolled_back_at TEXT,
  error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
  UNIQUE (player_id, source_sha256)
);

CREATE INDEX legacy_imports_player_status_idx ON legacy_save_imports(player_id, status, created_at);
CREATE INDEX legacy_imports_status_time_idx ON legacy_save_imports(status, created_at);

CREATE TABLE admin_audit_log (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE RESTRICT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  before_json TEXT CHECK (before_json IS NULL OR json_valid(before_json)),
  after_json TEXT CHECK (after_json IS NULL OR json_valid(after_json)),
  ip_address TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (admin_id, request_id, action)
);

CREATE INDEX admin_audit_target_idx ON admin_audit_log(target_type, target_id, created_at);
CREATE INDEX admin_audit_admin_idx ON admin_audit_log(admin_id, created_at);

CREATE TABLE config_state (
  environment TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  manifest_url TEXT NOT NULL,
  activated_by_admin_id TEXT REFERENCES admin_users(id) ON DELETE SET NULL,
  activated_at TEXT NOT NULL
);

CREATE TABLE gift_claims (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL,
  gift_code TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  provider_receipt TEXT,
  reward_json TEXT NOT NULL CHECK (json_valid(reward_json)),
  claimed_at TEXT NOT NULL,
  UNIQUE (player_id, provider, gift_code),
  UNIQUE (player_id, idempotency_key)
);

CREATE TABLE game_events (
  event_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
  player_id TEXT REFERENCES players(id) ON DELETE SET NULL,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  match_id TEXT REFERENCES matches(id) ON DELETE SET NULL,
  event_name TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  platform TEXT NOT NULL,
  client_build TEXT NOT NULL,
  config_version TEXT NOT NULL,
  properties_json TEXT NOT NULL CHECK (json_valid(properties_json)),
  export_date TEXT NOT NULL
);

CREATE INDEX game_events_export_idx ON game_events(export_date, received_at);
CREATE INDEX game_events_player_time_idx ON game_events(player_id, occurred_at);
CREATE INDEX game_events_name_time_idx ON game_events(event_name, occurred_at);
CREATE INDEX game_events_session_time_idx ON game_events(session_id, occurred_at);
CREATE INDEX game_events_match_time_idx ON game_events(match_id, occurred_at);

INSERT INTO schema_metadata(key, value, updated_at)
VALUES ('canonical_schema_version', '1', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
