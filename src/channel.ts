import { assertService } from "./errors.ts";

export interface ChannelCapabilities {
  supportsPayment: boolean;
  supportsSensitiveWords: boolean;
  supportsRoleQuery: boolean;
  supportsGiftClaims: boolean;
}

export interface VerifiedChannelIdentity {
  subject: string;
  displayName?: string;
  metadata?: Record<string, string>;
}

export interface ChannelContext {
  clientVersion: string;
  ipAddress?: string;
  userAgent?: string;
}

export interface ChannelAdapter {
  readonly platform: string;
  readonly capabilities: ChannelCapabilities;
  verifyLoginTicket(ticket: string, context: ChannelContext): Promise<VerifiedChannelIdentity>;
  containsSensitiveWords(text: string): Promise<boolean>;
  queryRole(subject: string): Promise<Record<string, string>>;
  claimGift(subject: string, giftCode: string, idempotencyKey: string): Promise<{ claimed: boolean }>;
}

export interface Platform4399Gateway {
  exchangeTicket(ticket: string, context: ChannelContext): Promise<VerifiedChannelIdentity>;
  containsSensitiveWords(text: string): Promise<boolean>;
  queryRole(subject: string): Promise<Record<string, string>>;
  claimGift(subject: string, giftCode: string, idempotencyKey: string): Promise<{ claimed: boolean }>;
}

/**
 * The browser supplies only a one-time platform ticket. The injected gateway must
 * perform the official server-to-server verification; no browser-supplied UID is accepted.
 */
export class Platform4399Adapter implements ChannelAdapter {
  readonly platform = "4399";
  readonly capabilities: ChannelCapabilities = {
    supportsPayment: false,
    supportsSensitiveWords: true,
    supportsRoleQuery: true,
    supportsGiftClaims: true,
  };

  private readonly gateway: Platform4399Gateway;

  constructor(gateway: Platform4399Gateway) {
    this.gateway = gateway;
  }

  async verifyLoginTicket(ticket: string, context: ChannelContext): Promise<VerifiedChannelIdentity> {
    assertService(ticket.trim().length >= 8, 400, "INVALID_CHANNEL_TICKET", "channel ticket is malformed");
    const identity = await this.gateway.exchangeTicket(ticket, context);
    assertService(identity.subject.trim().length > 0, 502, "CHANNEL_VERIFICATION_FAILED", "channel returned no subject");
    return identity;
  }

  containsSensitiveWords(text: string): Promise<boolean> {
    return this.gateway.containsSensitiveWords(text);
  }

  queryRole(subject: string): Promise<Record<string, string>> {
    return this.gateway.queryRole(subject);
  }

  claimGift(subject: string, giftCode: string, idempotencyKey: string): Promise<{ claimed: boolean }> {
    return this.gateway.claimGift(subject, giftCode, idempotencyKey);
  }
}

export class ChannelRegistry {
  private readonly adapters = new Map<string, ChannelAdapter>();

  constructor(adapters: ChannelAdapter[]) {
    for (const adapter of adapters) this.adapters.set(adapter.platform, adapter);
  }

  get(platform: string): ChannelAdapter {
    const adapter = this.adapters.get(platform);
    assertService(adapter, 400, "UNSUPPORTED_CHANNEL", `unsupported channel: ${platform}`);
    return adapter;
  }
}
