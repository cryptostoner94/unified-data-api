import { describe, expect, it, vi } from "vitest";
import { backoffDelayMs, parseRetryAfterMs, withRetry } from "../../src/core/retry.js";
import { LicenseInvalid, NetworkError, UpstreamRateLimited } from "../../src/core/errors.js";

describe("parseRetryAfterMs", () => {
  it("parses delta-seconds", () => {
    expect(parseRetryAfterMs("120")).toBe(120_000);
    expect(parseRetryAfterMs("0")).toBe(0);
  });
  it("parses HTTP dates", () => {
    const future = new Date(Date.now() + 5000).toUTCString();
    const ms = parseRetryAfterMs(future)!;
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(5000);
  });
  it("returns undefined for missing/garbage values", () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs("")).toBeUndefined();
    expect(parseRetryAfterMs("soon-ish")).toBeUndefined();
  });
});

describe("backoffDelayMs", () => {
  it("is exponential and capped", () => {
    expect(backoffDelayMs(1, 500, 10_000, false)).toBe(500);
    expect(backoffDelayMs(2, 500, 10_000, false)).toBe(1000);
    expect(backoffDelayMs(3, 500, 10_000, false)).toBe(2000);
    expect(backoffDelayMs(10, 500, 10_000, false)).toBe(10_000);
  });
  it("jitter stays within [exp/2, exp]", () => {
    for (let i = 0; i < 50; i++) {
      const d = backoffDelayMs(2, 500, 10_000, true);
      expect(d).toBeGreaterThanOrEqual(500);
      expect(d).toBeLessThanOrEqual(1000);
    }
  });
});

describe("withRetry", () => {
  it("succeeds on the first attempt without sleeping", async () => {
    const sleep = vi.fn(async () => {});
    const result = await withRetry(async () => "ok", { sleep });
    expect(result).toBe("ok");
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries retryable errors and honors Retry-After over backoff", async () => {
    const sleep = vi.fn(async () => {});
    const delays: number[] = [];
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts++;
        if (attempts < 3) throw new UpstreamRateLimited("429", 2500);
        return "recovered";
      },
      {
        maxAttempts: 4,
        maxDelayMs: 60_000,
        jitter: false,
        sleep: async (ms) => {
          delays.push(ms);
          await sleep(ms);
        },
      },
    );
    expect(result).toBe("recovered");
    expect(attempts).toBe(3);
    // Server-asked delay honored (not the exponential backoff).
    expect(delays).toEqual([2500, 2500]);
  });

  it("retries NetworkError with exponential backoff", async () => {
    const delays: number[] = [];
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts++;
          throw new NetworkError("down");
        },
        { maxAttempts: 3, baseDelayMs: 100, jitter: false, sleep: async (ms) => void delays.push(ms) },
      ),
    ).rejects.toBeInstanceOf(NetworkError);
    expect(attempts).toBe(3);
    expect(delays).toEqual([100, 200]);
  });

  it("does not retry non-retryable taxonomy errors", async () => {
    const sleep = vi.fn(async () => {});
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts++;
          throw new LicenseInvalid("bad key");
        },
        { sleep },
      ),
    ).rejects.toBeInstanceOf(LicenseInvalid);
    expect(attempts).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("gives up after maxAttempts and throws the last error", async () => {
    let attempts = 0;
    const err = await withRetry(async () => {
      attempts++;
      throw new NetworkError(`fail ${attempts}`);
    }, { maxAttempts: 2, baseDelayMs: 1, jitter: false, sleep: async () => {} }).catch((e) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect((err as Error).message).toBe("fail 2");
    expect(attempts).toBe(2);
  });
});
