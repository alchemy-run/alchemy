/**
 * Object storage a control plane of several engines shares: where the
 * durable copy of every actor's data lives.
 *
 * @internal
 */
import type { Input } from "alchemy/Input";
import * as Config from "effect/Config";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";

/**
 * Where the control plane keeps the durable copy of every actor's data. The
 * engine reaches it over HTTPS only.
 */
export type ObjectStorage =
  | {
      /** An S3 (or S3-compatible, e.g. R2) bucket. */
      readonly kind: "s3";
      readonly bucket: Input<string>;
      readonly region?: Input<string>;
      /** An HTTPS endpoint for an S3-compatible service. */
      readonly endpoint?: Input<string>;
      readonly accessKeyId?: Input<string> | Config.Config<string>;
      readonly secretAccessKey?:
        | Input<Redacted.Redacted<string>>
        | Config.Config<Redacted.Redacted<string>>;
      readonly prefix?: string;
    }
  | {
      /** A Google Cloud Storage bucket. */
      readonly kind: "gcs";
      readonly bucket: Input<string>;
      /** A service account key (JSON). Defaults to application default credentials. */
      readonly serviceAccountKey?:
        | Input<Redacted.Redacted<string>>
        | Config.Config<Redacted.Redacted<string>>;
      readonly prefix?: string;
    };

/** More than one engine with nowhere to share data. */
export class ObjectStorageRequired extends Data.TaggedError("Rivet.ObjectStorageRequired")<{
  readonly message: string;
}> {}

/**
 * The engine environment variables that point it at `storage`, with any
 * `Config` value read.
 */
export const objectStorageEnvironment = Effect.fn(function* (storage: ObjectStorage) {
  const prefix = storage.prefix === undefined ? [] : [["PREFIX", storage.prefix] as const];
  const entries: ReadonlyArray<readonly [string, unknown]> =
    storage.kind === "s3"
      ? [
          ["BUCKET", storage.bucket],
          ["REGION", storage.region],
          ["ENDPOINT", storage.endpoint],
          ["ACCESS_KEY_ID", storage.accessKeyId],
          ["SECRET_ACCESS_KEY", storage.secretAccessKey],
          ...prefix,
        ]
      : [["BUCKET", storage.bucket], ["SERVICE_ACCOUNT_KEY", storage.serviceAccountKey], ...prefix];
  return yield* Effect.forEach(
    entries.filter(([, value]) => value !== undefined),
    ([key, value]) =>
      (Config.isConfig(value) ? (value as Config.Config<unknown>) : Effect.succeed(value)).pipe(
        Effect.map(
          (resolved) =>
            [
              `RIVET__OBJECT_STORAGE__PRIMARY__${storage.kind.toUpperCase()}__${key}`,
              resolved,
            ] as const,
        ),
      ),
  );
});
