/**
 * Abuse Protection: Salted-Hash IP Rate Limiter
 * =============================================
 * Privacy-preserving rate limiting:
 * 1. Hashes client IP with a server salt and hourly rotating key.
 * 2. Raw IP address is NEVER stored or logged.
 * 3. Limits submissions to e.g. 5 per 10 minutes per client hash.
 * 4. Automatic pruning of expired timestamps.
 */

import { createHash, randomBytes } from 'node:crypto';

// Ephemeral server salt generated at startup
const SERVER_SALT = randomBytes(16).toString('hex');

interface RateLimitBucket {
  timestamps: number[];
}

export class RateLimiter {
  private buckets: Map<string, RateLimitBucket> = new Map();
  private maxRequests: number;
  private windowMs: number;

  constructor(maxRequests: number = 5, windowMinutes: number = 10) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMinutes * 60 * 1000;
  }

  /**
   * Hashes client IP using SHA-256 with server salt and current hour block.
   */
  public hashClientIp(ip: string): string {
    const hourBlock = Math.floor(Date.now() / (60 * 60 * 1000));
    return createHash('sha256')
      .update(`${SERVER_SALT}:${ip}:${hourBlock}`)
      .digest('hex')
      .substring(0, 32);
  }

  /**
   * Checks if an IP exceeds rate limit. Returns { allowed: boolean, remaining: number, retryAfterSeconds: number }.
   */
  public checkLimit(ip: string): {
    allowed: boolean;
    remaining: number;
    retryAfterSeconds: number;
  } {
    const key = this.hashClientIp(ip);
    const now = Date.now();
    const cutoff = now - this.windowMs;

    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { timestamps: [] };
      this.buckets.set(key, bucket);
    }

    // Filter out timestamps outside current window
    bucket.timestamps = bucket.timestamps.filter((t) => t > cutoff);

    if (bucket.timestamps.length >= this.maxRequests) {
      const oldestInWindow = bucket.timestamps[0];
      const retryAfter = Math.ceil((oldestInWindow + this.windowMs - now) / 1000);
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, retryAfter),
      };
    }

    // Record this attempt
    bucket.timestamps.push(now);

    return {
      allowed: true,
      remaining: this.maxRequests - bucket.timestamps.length,
      retryAfterSeconds: 0,
    };
  }

  public reset(): void {
    this.buckets.clear();
  }
}

let globalRateLimiter: RateLimiter | null = null;

export function getGlobalRateLimiter(): RateLimiter {
  if (!globalRateLimiter) {
    globalRateLimiter = new RateLimiter();
  }
  return globalRateLimiter;
}
