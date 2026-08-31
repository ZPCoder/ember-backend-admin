import { ChannelRegistry } from "./channel.ts";
import { createOpaqueToken, sha256 } from "./crypto.ts";
import { assertService } from "./errors.ts";
import { assertProtocolVersion, CURRENT_PROTOCOL_VERSION, type Clock } from "./runtime.ts";
import type { BackendStore } from "./store.ts";
import type { ChannelLoginRequest, ChannelLoginResponse, SessionPrincipal } from "./types.ts";

export class AuthService {
  private readonly store: BackendStore;
  private readonly channels: ChannelRegistry;
  private readonly clock: Clock;
  private readonly sessionLifetimeMs: number;

  constructor(store: BackendStore, channels: ChannelRegistry, clock: Clock, sessionLifetimeMs = 15 * 60 * 1000) {
    this.store = store;
    this.channels = channels;
    this.clock = clock;
    this.sessionLifetimeMs = sessionLifetimeMs;
  }

  async exchange(
    request: ChannelLoginRequest,
    context: { ipAddress?: string; userAgent?: string } = {},
  ): Promise<ChannelLoginResponse> {
    const allowedFields = new Set(["platform", "ticket", "clientVersion", "protocolVersion", "deviceId"]);
    assertService(
      Object.keys(request).every((field) => allowedFields.has(field)),
      400,
      "INVALID_CHANNEL_LOGIN",
      "channel login contains an unknown field",
    );
    assertService(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(request.clientVersion), 400, "CLIENT_VERSION_REQUIRED", "client version must be SemVer");
    assertProtocolVersion(request.protocolVersion);
    const adapter = this.channels.get(request.platform);
    const identity = await adapter.verifyLoginTicket(request.ticket, {
      clientVersion: request.clientVersion,
      ...(context.ipAddress === undefined ? {} : { ipAddress: context.ipAddress }),
      ...(context.userAgent === undefined ? {} : { userAgent: context.userAgent }),
    });
    const accessToken = createOpaqueToken();
    const [ticketHash, tokenHash] = await Promise.all([
      sha256(`${request.platform}\u0000${request.ticket}`),
      sha256(accessToken),
    ]);
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + this.sessionLifetimeMs).toISOString();
    const result = await this.store.createAuthenticatedSession({
      platform: request.platform,
      subject: identity.subject,
      ...(identity.displayName === undefined ? {} : { displayName: identity.displayName }),
      ticketHash,
      tokenHash,
      expiresAt,
      now: now.toISOString(),
    });
    const config = await this.store.getConfigState();
    return {
      accessToken,
      expiresAt,
      player: {
        id: result.player.id,
        displayName: result.player.commanderName,
        version: result.player.version,
      },
      configVersion: config.version,
      protocolVersion: CURRENT_PROTOCOL_VERSION,
    };
  }

  async authenticate(accessToken: string): Promise<SessionPrincipal> {
    assertService(accessToken.startsWith("ep_") && accessToken.length > 10, 401, "INVALID_SESSION", "access token is malformed");
    const principal = await this.store.resolveSession(await sha256(accessToken), this.clock.now().toISOString());
    assertService(principal, 401, "SESSION_EXPIRED", "session is invalid or expired");
    return principal;
  }
}
