import { createClient } from "redis";

export class MemoryCoordinator {
  constructor() {
    this.values = new Map();
  }

  cleanup() {
    const timestamp = Date.now();
    for (const [key, value] of this.values) {
      if (value.expiresAt <= timestamp) this.values.delete(key);
    }
  }

  async claimNonce(agentId, nonce, ttlSeconds = 300) {
    this.cleanup();
    const key = `nonce:${agentId}:${nonce}`;
    if (this.values.has(key)) return false;
    this.values.set(key, { count: 1, expiresAt: Date.now() + ttlSeconds * 1000 });
    return true;
  }

  async rateLimit(key, limit, windowSeconds) {
    this.cleanup();
    const fullKey = `rate:${key}`;
    const existing = this.values.get(fullKey);
    if (!existing) {
      this.values.set(fullKey, { count: 1, expiresAt: Date.now() + windowSeconds * 1000 });
      return { allowed: true, remaining: Math.max(0, limit - 1), retryAfter: windowSeconds };
    }
    existing.count += 1;
    return {
      allowed: existing.count <= limit,
      remaining: Math.max(0, limit - existing.count),
      retryAfter: Math.max(1, Math.ceil((existing.expiresAt - Date.now()) / 1000)),
    };
  }

  async ping() { return true; }
  async close() {}
}

export class RedisCoordinator {
  constructor(client) {
    this.client = client;
  }

  async claimNonce(agentId, nonce, ttlSeconds = 300) {
    const result = await this.client.set(`cohort:nonce:${agentId}:${nonce}`, "1", { NX: true, EX: ttlSeconds });
    return result === "OK";
  }

  async rateLimit(key, limit, windowSeconds) {
    const fullKey = `cohort:rate:${key}`;
    const count = Number(await this.client.eval(
      "local n = redis.call('INCR', KEYS[1]); if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]); end; return n",
      { keys: [fullKey], arguments: [String(windowSeconds)] },
    ));
    const ttl = Number(await this.client.ttl(fullKey));
    return {
      allowed: count <= limit,
      remaining: Math.max(0, limit - count),
      retryAfter: Math.max(1, ttl),
    };
  }

  async ping() { return (await this.client.ping()) === "PONG"; }

  async close() {
    if (this.client.isOpen) await this.client.quit();
  }
}

export async function createCoordinator({ url = process.env.REDIS_URL, production = process.env.NODE_ENV === "production" } = {}) {
  if (!url) {
    if (production) throw new Error("REDIS_URL is required in production for replay protection and distributed rate limits");
    return new MemoryCoordinator();
  }
  const client = createClient({ url });
  client.on("error", (error) => console.error("Coordination store error", error));
  await client.connect();
  return new RedisCoordinator(client);
}
