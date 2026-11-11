/**
 * A user's project, as both versions in an upgrade run it. The harness copies
 * this file into a project with the released packages installed and into one
 * linked to the workspace, and deploys it with each version's CLI against
 * one state store. Only the environment says which store and which
 * encryption to use, so the file itself never changes across the upgrade.
 *
 * - `UPGRADE_STORE`: `dynamodb`, `s3`, `gcs`, `local`, `postgres` or `cloudflare`
 * - `UPGRADE_STORE_NAME`: the AWS store's name
 * - `UPGRADE_KMS_KEY`: a customer key, as the released `kmsKeyId` (DynamoDB)
 *   or bucket `encryption` (S3) option
 * - `UPGRADE_ENCRYPTION`: `kms`, `kms-disable`, `passphrase` or
 *   `passphrase-disable`; a layer only the new version has
 * - `UPGRADE_GCS_BUCKET`, `UPGRADE_PG_URL`, `UPGRADE_CF_WORKER`: the Cloud
 *   Storage, Postgres and Cloudflare stores
 * - `UPGRADE_LARGE`: add a secret larger than the DynamoDB store's overflow
 *   threshold, which is lowered to 2 KiB so it goes to the overflow bucket
 */
import * as AWS from "@alchemy.run/aws";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as GCP from "@alchemy.run/gcp";
import { postgresState } from "@alchemy.run/sql/PostgresState";
import * as Alchemy from "alchemy";
import type { StackServices } from "alchemy/Stack";
import type { State } from "alchemy/State";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

/** Options of the released `AWS.state`, which the new one no longer takes. */
type ReleasedStateOptions = AWS.StateOptions & { kmsKeyId?: string };

/** Small enough that `Large`, and only it, overflows to the bucket. */
const OVERFLOW_THRESHOLD = 2048;

const optional = (name: string) => Config.String(name).pipe(Config.withDefault(""));

/** Any of the stores, as the stack takes it. */
type StateLayer = Layer.Layer<State, unknown, StackServices>;

const encryptionLayer = Effect.fn(function* (encryption: string, kmsKey: string) {
  const kmsKeyId = kmsKey === "" ? undefined : kmsKey;
  switch (encryption) {
    case "kms":
      return AWS.stateEncryption({ kmsKeyId });
    case "kms-disable":
      return AWS.stateEncryption({ kmsKeyId, disable: true });
    case "passphrase":
    case "passphrase-disable": {
      // Only the new version has the module, so it is loaded only when asked for.
      const { passphraseEncryption } = yield* Effect.promise(
        () => import("alchemy/State/PassphraseEncryption"),
      );
      return passphraseEncryption({ disable: encryption === "passphrase-disable" });
    }
    default:
      return undefined;
  }
});

const state = Layer.unwrap(
  Effect.gen(function* () {
    const store = yield* Config.String("UPGRADE_STORE");
    const name = yield* optional("UPGRADE_STORE_NAME");
    const kmsKey = yield* optional("UPGRADE_KMS_KEY");
    const encryption = yield* encryptionLayer(yield* optional("UPGRADE_ENCRYPTION"), kmsKey);

    const base: StateLayer = yield* Effect.gen(function* () {
      switch (store) {
        case "dynamodb": {
          const large = yield* Config.Boolean("UPGRADE_LARGE").pipe(Config.withDefault(false));
          const options: ReleasedStateOptions = {
            name,
            ...(large ? { overflowThreshold: OVERFLOW_THRESHOLD } : {}),
            ...(kmsKey !== "" && encryption === undefined ? { kmsKeyId: kmsKey } : {}),
          };
          return AWS.state(options) as StateLayer;
        }
        case "s3":
          return AWS.state({
            backend: "s3",
            name,
            ...(kmsKey === ""
              ? {}
              : { encryption: { sseAlgorithm: "aws:kms", kmsMasterKeyId: kmsKey } }),
          }) as StateLayer;
        case "gcs":
          return GCP.state({
            bucketName: yield* Config.String("UPGRADE_GCS_BUCKET"),
          }) as StateLayer;
        case "local":
          return Alchemy.localState() as StateLayer;
        case "postgres":
          return postgresState({
            url: Redacted.make(yield* Config.String("UPGRADE_PG_URL")),
          }) as StateLayer;
        case "cloudflare":
          return Cloudflare.state({
            workerName: yield* Config.String("UPGRADE_CF_WORKER"),
          }) as StateLayer;
        default:
          return yield* Effect.die(`unknown UPGRADE_STORE '${store}'`);
      }
    });
    return encryption === undefined
      ? base
      : (base.pipe(
          Layer.provide(encryption as Layer.Layer<never, unknown, StackServices>),
        ) as StateLayer);
  }),
).pipe(Layer.orDie);

export default Alchemy.Stack(
  "StateUpgrade",
  { providers: AWS.providers(), state },
  Effect.gen(function* () {
    const secret = yield* Alchemy.Random("Secret");
    const token = yield* Alchemy.Random("Token", { bytes: 16 });
    const large = yield* Config.Boolean("UPGRADE_LARGE").pipe(Config.withDefault(false));
    if (large) {
      // Hex doubles it: 8 KiB of text, above the lowered overflow threshold.
      yield* Alchemy.Random("Large", { bytes: 4096 });
    }
    return { secret: secret.text, token: token.text };
  }),
);
