import { createHash, generateKeyPairSync } from "node:crypto";
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

/**
 * A throwaway RSA private key (PKCS#8 PEM), made once per test process:
 * Galaxy parses keys it is given, so a test key must be a real one.
 */
export const testPrivateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

/**
 * A well-formed Google service account key for an account that does not
 * exist. `version` changes the key ID, so a rotation is a new value.
 */
export const serviceAccountKey = (version: string) =>
  Redacted.make(
    JSON.stringify({
      type: "service_account",
      project_id: "alchemy-test",
      private_key_id: createHash("sha256").update(version).digest("hex").slice(0, 40),
      private_key: testPrivateKey,
      client_email: "galaxy@alchemy-test.iam.gserviceaccount.com",
      client_id: "100000000000000000001",
      token_uri: "https://oauth2.googleapis.com/token",
    }),
  );
