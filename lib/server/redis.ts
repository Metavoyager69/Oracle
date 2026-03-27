// Tiny REST-backed Redis client used by the server runtime. Keeping this
// local avoids taking a hard dependency on the full Upstash SDK in builds.
type RedisSetOptions = {
  nx?: boolean;
  px?: number;
};

export interface RedisClient {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  ttl(key: string): Promise<number>;
  set(key: string, value: string, options?: RedisSetOptions): Promise<string | null>;
}

// Reuse one client per process so route handlers do not rebuild config on
// every request.
let client: RedisClient | null = null;

class UpstashRedisRestClient implements RedisClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(url: string, token: string) {
    this.baseUrl = url.replace(/\/+$/, "");
    this.token = token;
  }

  async incr(key: string): Promise<number> {
    return this.command<number>(["incr", key]);
  }

  async expire(key: string, seconds: number): Promise<number> {
    return this.command<number>(["expire", key, seconds]);
  }

  async ttl(key: string): Promise<number> {
    return this.command<number>(["ttl", key]);
  }

  async set(key: string, value: string, options?: RedisSetOptions): Promise<string | null> {
    const args: Array<string | number> = ["set", key, value];
    if (options?.nx) {
      args.push("NX");
    }
    if (typeof options?.px === "number") {
      args.push("PX", options.px);
    }
    return this.command<string | null>(args);
  }

  private async command<T>(args: Array<string | number>): Promise<T> {
    // Upstash's REST API maps Redis commands onto path segments, so each
    // argument is encoded independently before the POST.
    const path = args.map((arg) => encodeURIComponent(String(arg))).join("/");
    const response = await fetch(`${this.baseUrl}/${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
    });

    const payloadText = await response.text();
    let payload: { result?: T; error?: string };

    try {
      payload = payloadText ? (JSON.parse(payloadText) as { result?: T; error?: string }) : {};
    } catch {
      throw new Error(`Upstash request returned invalid JSON (${response.status}).`);
    }

    if (!response.ok || payload.error) {
      throw new Error(payload.error ?? `Upstash request failed with status ${response.status}.`);
    }

    return payload.result as T;
  }
}

export function isRedisConfigured(): boolean {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

export function getRedisClient(): RedisClient | null {
  if (!isRedisConfigured()) return null;
  if (!client) {
    // Lazy init keeps local development/test runs free of Redis requirements
    // until a caller actually needs rate-limiting storage.
    client = new UpstashRedisRestClient(
      process.env.UPSTASH_REDIS_REST_URL as string,
      process.env.UPSTASH_REDIS_REST_TOKEN as string
    );
  }
  return client;
}
