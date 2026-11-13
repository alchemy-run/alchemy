// Emulated Ratelimit Binding
import type { RateLimitProps } from "./RateLimitProps.shared.ts";

// options for Ratelimit
//   (should be kept in sync with https://bitbucket.cfdata.org/projects/EW/repos/edgeworker/browse/src/edgeworker/internal-api/ratelimit.capnp)
const RATE_LIMIT_OPTION_KEYS = ["key", "limit", "period", "delta"];
const RATE_LIMIT_PERIOD_VALUES = [10, 60];
const MAX_UINT32 = 0xffffffff;

// create a new Ratelimit
export default function makeBinding(env: { PROPS: RateLimitProps }) {
  return new RateLimitBinding(env.PROPS);
}

interface Bucket {
  count: number;
  resetAt: number;
}

class RateLimitBinding implements RateLimit {
  // Per-key fixed windows anchored at each key's first request. A single
  // wall-clock-aligned epoch (`floor(now / period)`) is wrong twice over:
  // an absolute period boundary crossing between requests wipes the counter
  // mid-sequence, and a shared epoch lets a call with one period clear the
  // buckets of every other key/period.
  buckets: Map<string, Bucket>;

  constructor(readonly config: RateLimitProps) {
    this.buckets = new Map<string, Bucket>();
  }

  // method that counts and checks against the limit in in-memory buckets
  async limit(options: RateLimitOptions): Promise<RateLimitOutcome> {
    // validate options input
    validate(typeof options === "object" && options !== null, "invalid rate limit options");
    const invalidProps = Object.keys(options ?? {}).filter(
      (key) => !RATE_LIMIT_OPTION_KEYS.includes(key),
    );
    validate(invalidProps.length == 0, `bad rate limit options: [${invalidProps.join(",")}]`);
    const {
      key = "",
      limit = this.config.simple.limit,
      period = this.config.simple.period,
      delta = 1,
    } = options as RateLimitOptions & Partial<RateLimitProps["simple"]> & { delta?: unknown };
    validate(typeof key === "string", `invalid key: ${key}`);
    validate(typeof limit === "number", `limit must be a number: ${limit}`);
    validate(typeof period === "number", `period must be a number: ${period}`);
    validate(RATE_LIMIT_PERIOD_VALUES.includes(period), `unsupported period: ${period}`);
    const weight = toDelta(delta);

    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (bucket === undefined || now >= bucket.resetAt) {
      // drop other expired windows while we're here so the map stays bounded
      for (const [k, b] of this.buckets) {
        if (now >= b.resetAt) {
          this.buckets.delete(k);
        }
      }
      bucket = { count: 0, resetAt: now + period * 1000 };
      this.buckets.set(key, bucket);
    }
    // Like production, the decision is made on the count *before* this call,
    // so a weighted call is allowed whenever any headroom remains (even if it
    // overshoots the limit), and a rejected call adds nothing.
    if (bucket.count >= limit) {
      return {
        success: false,
      };
    }
    bucket.count += weight;
    return {
      success: true,
    };
  }
}

/**
 * Converts `delta` to a non-zero `uint32`, truncating fractions. Values
 * outside the `uint32` range throw `TypeError` and zero throws `RangeError`,
 * matching the deployed binding's errors.
 *
 * @param delta The `delta` option passed to `limit()`.
 * @returns The weight to add to the counter.
 */
function toDelta(delta: unknown): number {
  // Unary `+` applies `ToNumber`, so a BigInt throws `TypeError` (whereas
  // `Number(2n)` would silently convert it)
  const value = +(delta as number);
  if (!Number.isFinite(value)) {
    throw new TypeError("The value cannot be converted because it is not an integer.");
  }
  if (value < 0) {
    throw new TypeError(
      "The value cannot be converted because it is negative and this API expects a positive number.",
    );
  }
  if (value > MAX_UINT32) {
    throw new TypeError(`Value out of range. Must be less than or equal to ${MAX_UINT32}.`);
  }
  const truncated = Math.trunc(value);
  if (truncated === 0) {
    throw new RangeError("delta must be non-zero");
  }
  return truncated;
}

function validate(test: boolean, message: string): asserts test {
  if (!test) {
    throw new Error(message);
  }
}
