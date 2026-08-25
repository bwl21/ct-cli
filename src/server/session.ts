import { randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "ct_ui_session";

function secret(): string {
  return randomBytes(32).toString("base64url");
}

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** One browser session with a single-use fragment bootstrap secret. */
export class LocalServerSession {
  readonly bootstrapSecret: string;
  private readonly sessionSecret: string;
  private bootstrapUsed = false;

  constructor(values: { bootstrapSecret?: string; sessionSecret?: string } = {}) {
    this.bootstrapSecret = values.bootstrapSecret ?? secret();
    this.sessionSecret = values.sessionSecret ?? secret();
  }

  exchange(candidate: string): string | null {
    if (this.bootstrapUsed || !equal(candidate, this.bootstrapSecret)) return null;
    this.bootstrapUsed = true;
    return this.sessionSecret;
  }

  accepts(candidate: string | undefined): boolean {
    return candidate !== undefined && equal(candidate, this.sessionSecret);
  }
}
