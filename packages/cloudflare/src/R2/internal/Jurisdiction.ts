import { Jurisdiction } from "@distilled.cloud/cloudflare/Jurisdiction";
import * as Effect from "effect/Effect";
import type { Bucket } from "../Bucket.ts";

/**
 * Send an effect's R2 calls to a bucket's jurisdiction. distilled reads the
 * jurisdiction from this service, not from each request; without it, calls go
 * to Cloudflare's default jurisdiction.
 */
export const inJurisdiction =
  (jurisdiction: Bucket.Jurisdiction | undefined) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    jurisdiction === undefined
      ? effect
      : effect.pipe(Effect.provideService(Jurisdiction, jurisdiction));
