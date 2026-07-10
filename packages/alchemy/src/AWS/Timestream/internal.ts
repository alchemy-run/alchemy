import { Endpoint } from "@distilled.cloud/aws";
import * as TSQ from "@distilled.cloud/aws/timestream-query";
import * as TSW from "@distilled.cloud/aws/timestream-write";
import * as Effect from "effect/Effect";

/**
 * Amazon Timestream uses the **endpoint discovery** pattern: control-plane and
 * data-plane requests must be routed to a cell-specific endpoint returned by
 * `DescribeEndpoints`, not the static regional endpoint (which answers every
 * operation other than `DescribeEndpoints` with `UnknownOperationException`).
 *
 * These helpers call `DescribeEndpoints` once, cache the discovered address for
 * its advertised `CachePeriodInMinutes`, and wrap a distilled Timestream effect
 * so it targets the discovered endpoint via the `Endpoint` service override.
 */

type Kind = "write" | "query";

interface CachedEndpoint {
  readonly url: string;
  readonly expiresAt: number;
}

// Module-level cache keyed by discovery kind. `DescribeEndpoints` is a cheap
// call but the API asks clients to respect the returned cache period; caching
// also avoids an extra round-trip on every write/query.
const cache = new Map<Kind, CachedEndpoint>();

const discoverWrite = TSW.describeEndpoints({});
const discoverQuery = TSQ.describeEndpoints({});

const discover = (kind: Kind) =>
  Effect.gen(function* () {
    const now = Date.now();
    const cached = cache.get(kind);
    if (cached !== undefined && cached.expiresAt > now) {
      return cached.url;
    }
    const response = yield* kind === "write" ? discoverWrite : discoverQuery;
    const endpoint = response.Endpoints[0];
    const url = `https://${endpoint.Address}`;
    cache.set(kind, {
      url,
      expiresAt: now + (endpoint.CachePeriodInMinutes ?? 5) * 60_000,
    });
    return url;
  });

const withEndpoint =
  (kind: Kind) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    discover(kind).pipe(
      Effect.flatMap((url) =>
        effect.pipe(
          Effect.provideService(Endpoint.Endpoint, Effect.succeed(url)),
        ),
      ),
    );

/**
 * Route a distilled `timestream-write` effect through the discovered ingest
 * endpoint. Adds `DescribeEndpoints`'s error union (including the synthetic
 * `TimestreamNotOnboarded` tag) to the wrapped effect's errors.
 */
export const withWriteEndpoint = withEndpoint("write");

/**
 * Route a distilled `timestream-query` effect through the discovered query
 * endpoint.
 */
export const withQueryEndpoint = withEndpoint("query");
