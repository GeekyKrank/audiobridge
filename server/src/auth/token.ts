import { createHash, timingSafeEqual } from 'node:crypto';

const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();

/** Constant-time comparison (hashing first makes the lengths equal). */
export function tokensMatch(given: unknown, expected: string): boolean {
  if (typeof given !== 'string' || given.length === 0 || given.length > 512) return false;
  return timingSafeEqual(digest(given), digest(expected));
}

/**
 * Counts failed authentication attempts per client IP and blocks an IP for a
 * while after too many failures. Keeps memory bounded.
 */
export class AuthLimiter {
  private readonly failures = new Map<string, { count: number; first: number }>();

  constructor(
    private readonly maxFailures = 10,
    private readonly windowMs = 10 * 60_000,
  ) {}

  isBlocked(ip: string, now = Date.now()): boolean {
    const f = this.failures.get(ip);
    if (!f) return false;
    if (now - f.first > this.windowMs) {
      this.failures.delete(ip);
      return false;
    }
    return f.count >= this.maxFailures;
  }

  fail(ip: string, now = Date.now()): void {
    const f = this.failures.get(ip);
    if (!f || now - f.first > this.windowMs) this.failures.set(ip, { count: 1, first: now });
    else f.count++;
    if (this.failures.size > 10_000) this.failures.clear();
  }

  succeed(ip: string): void {
    this.failures.delete(ip);
  }
}
