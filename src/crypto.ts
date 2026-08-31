const encoder = new TextEncoder();

export async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createOpaqueToken(): string {
  const random = crypto.getRandomValues(new Uint8Array(32));
  const encoded = Array.from(random, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `ep_${encoded}`;
}

export function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}
