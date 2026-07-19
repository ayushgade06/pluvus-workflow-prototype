// ---------------------------------------------------------------------------
// Redis configuration for BullMQ
// ---------------------------------------------------------------------------
// BullMQ v5 bundles its own ioredis internally. We pass a plain object with
// host/port so BullMQ constructs its own connections — no external ioredis
// import needed, avoiding cross-package type conflicts.
//
// `maxRetriesPerRequest: null` is required by BullMQ for blocking commands.

export interface BullMQConnection {
  host: string;
  port: number;
  username?: string;
  password?: string;
  tls?: Record<string, unknown>;
  maxRetriesPerRequest: null;
  enableReadyCheck: boolean;
}

export function redisConnection(): BullMQConnection {
  const url = process.env["REDIS_URL"] ?? "redis://localhost:6379";
  try {
    const u = new URL(url);
    return {
      host: u.hostname || "127.0.0.1",
      port: u.port ? Number(u.port) : 6379,
      // exactOptionalPropertyTypes: never assign `undefined` to optional keys —
      // spread the key only when a real value exists.
      ...(u.username ? { username: u.username } : {}),
      ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
      ...(u.protocol === "rediss:" ? { tls: {} as Record<string, unknown> } : {}),
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    };
  } catch {
    return {
      host: "127.0.0.1",
      port: 6379,
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    };
  }
}
