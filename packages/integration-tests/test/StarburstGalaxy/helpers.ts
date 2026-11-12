import { createHash } from "node:crypto";
import { expect } from "@alchemy.run/test";
import { Stage } from "alchemy/Stage";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

/**
 * A per-stage name for tests about explicit names: the same on every run
 * of the test by the same user, distinct between users, and short enough
 * for Galaxy's tightest rule (30 characters for clusters, masks, filters
 * and tags): `alchemy<d><suffix><d><8 hex of the stage>`. `_` for SQL
 * identifiers (catalogs, roles, masks, tags, accounts), `-` for clusters,
 * jobs and domains.
 */
export const pinnedName = (suffix: string, delimiter: "_" | "-" = "_") =>
  Effect.gen(function* () {
    const stage = yield* Stage;
    const tag = createHash("sha256").update(stage).digest("hex").slice(0, 8);
    return `alchemy${delimiter}${suffix}${delimiter}${tag}`;
  });

/**
 * Host for catalogs stored with `validate: false`. Galaxy still checks
 * that the host resolves to a public address in a known cloud region
 * (here AWS us-east-1); nothing ever connects to it.
 */
export const UNVALIDATED_ENDPOINT = "s3.us-east-1.amazonaws.com";

/**
 * Wait until `exists` reports the object gone, bounded at 60 seconds, and
 * assert it. `exists` answers `false` only on the API's typed `NotFound`.
 */
export const expectGone = <E, R>(exists: Effect.Effect<boolean, E, R>) =>
  exists.pipe(
    Effect.repeat({
      until: (present) => !present,
      schedule: Schedule.spaced("3 seconds"),
      times: 20,
    }),
    Effect.map((present) => expect(present).toBe(false)),
  );

/** A deterministic test secret; Galaxy only stores it. */
export const secret = (value: string) => Redacted.make(`alchemy-test-${value}`);
