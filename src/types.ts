export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface CommandEnvelope<TCommand> {
  protocolVersion: string;
  requestId: string;
  idempotencyKey: string;
  expectedVersion: number;
  command: TCommand;
}

export interface ChannelLoginRequest {
  platform: "4399" | "chatgpt" | "device";
  ticket: string;
  clientVersion: string;
  protocolVersion: string;
  deviceId?: string;
}

export interface ChannelLoginResponse {
  accessToken: string;
  expiresAt: string;
  player: {
    id: string;
    displayName: string;
    version: number;
  };
  configVersion: string;
  protocolVersion: string;
}

export interface PlayerView {
  id: string;
  commanderName: string;
  version: number;
  gold: number;
  dust: number;
  packs: Record<string, number>;
  collection: Record<string, number>;
  decks: DeckView[];
  format: "standard" | "wild";
  stats: PlayerStats;
}

export interface DeckView {
  slot: number;
  name: string;
  format: "standard" | "wild";
  deckCode?: string;
  cardIds: string[];
}

export interface PlayerStats {
  wins: number;
  losses: number;
  draws: number;
}

export type PlayerCommand =
  | { type: "set-commander-name"; commanderName: string }
  | { type: "save-deck"; deck: DeckView }
  | { type: "delete-deck"; slot: number };

export type BattlePlayerIndex = 0 | 1;

export type BattleTarget =
  | { type?: never; kind: "hero"; player: BattlePlayerIndex }
  | { type?: never; kind: "unit"; entityId: string };

interface BattleCommandBase {
  player: BattlePlayerIndex;
  commandId?: string;
  expectedVersion?: number;
}

export type BattleCommand =
  | (BattleCommandBase & { type: "mulligan"; cardIndexes: number[] })
  | (BattleCommandBase & { type: "play-card"; cardId: string; handIndex?: number; placement?: "friendly" | "enemy"; target?: BattleTarget })
  | (BattleCommandBase & { type: "trade-card" | "prepare-card"; cardId: string; handIndex?: number })
  | (BattleCommandBase & { type: "attack"; attackerId: string; target: BattleTarget })
  | (BattleCommandBase & { type: "hero-attack"; target: BattleTarget })
  | (BattleCommandBase & { type: "activate-location"; locationId: string; target?: BattleTarget })
  | (BattleCommandBase & { type: "use-titan-ability"; unitId: string; abilityIndex: number; target?: BattleTarget })
  | (BattleCommandBase & { type: "choose-discover"; cardId: string; choiceIndex?: number })
  | (BattleCommandBase & { type: "choose-one"; optionIndex: number })
  | (BattleCommandBase & { type: "hero-power"; target?: BattleTarget })
  | (BattleCommandBase & { type: "use-coin" })
  | (BattleCommandBase & { type: "end-turn"; reason?: "manual" | "timeout" })
  | (BattleCommandBase & { type: "concede" });

export interface VisibleCard {
  entityId: string;
  cardId: string;
  cost: number;
}

export interface PublicUnit {
  entityId: string;
  cardId: string;
  attack: number;
  health: number;
  maxHealth: number;
  canAttack: boolean;
  statuses?: string[];
}

export interface PublicPlayerState {
  playerId: string;
  heroHealth: number;
  heroArmor: number;
  mana: number;
  maxMana: number;
  deckCount: number;
  handCount: number;
  board: PublicUnit[];
}

export interface ViewerPlayerState extends PublicPlayerState {
  hand: VisibleCard[];
}

export interface RedactedMatchSnapshot {
  matchId: string;
  stateVersion: number;
  cursor: number;
  phase: "mulligan" | "playing" | "ended";
  turn: number;
  activePlayerId: string;
  viewer: ViewerPlayerState;
  opponent: PublicPlayerState;
  winnerId: string | null;
  deadlineAt?: string | null;
}

export interface PvpEvent {
  type: "snapshot" | "command-accepted" | "command-rejected" | "opponent-connected" | "opponent-disconnected" | "match-ended";
  occurredAt: string;
  payload: Record<string, JsonValue>;
}

export interface PvpEventEnvelope {
  protocolVersion: string;
  matchId: string;
  cursor: number;
  stateVersion: number;
  events: PvpEvent[];
  snapshot?: RedactedMatchSnapshot;
}

export interface LegacyFlutterSaveV1 {
  schemaVersion: 1;
  commanderName: string;
  collection: Record<string, number>;
  gold: number;
  dust: number;
  packs: Record<string, number>;
  decks: Array<{
    slot: number;
    name: string;
    format: "standard" | "wild";
    cardIds: string[];
    deckCode?: string;
  }>;
  format: "standard" | "wild";
  record: PlayerStats;
  exportedAt?: string;
}

export interface AssetDiff {
  field: string;
  before: JsonValue;
  after: JsonValue;
}

export interface LegacyMigrationPreview {
  migrationId: string;
  playerId: string;
  sourceHash: string;
  currentPlayerVersion: number;
  valid: boolean;
  errors: string[];
  diff: AssetDiff[];
}

export interface GameEvent {
  eventId: string;
  schemaVersion: number;
  sessionId?: string;
  playerId?: string;
  occurredAt: string;
  receivedAt?: string;
  eventName: string;
  properties: Record<string, JsonValue>;
}

export interface SessionPrincipal {
  sessionId: string;
  playerId: string;
  provider: string;
  expiresAt: string;
}

export interface AdminPrincipal {
  adminId: string;
  roles: string[];
}

export interface AdminAuditEntry {
  id: string;
  adminId: string;
  action: string;
  targetType: string;
  targetId: string;
  requestId: string;
  before?: JsonValue;
  after?: JsonValue;
  createdAt: string;
}

export interface ConfigState {
  version: string;
  sha256: string;
  activatedAt: string;
}
