import * as Effect from "effect/Effect";
import * as CoreBinding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import { sanitizeKey } from "../../RuntimeContext.ts";
import { isWorker, type Worker, WorkerEnvironment } from "../Workers/Worker.ts";
import type { Bucket } from "./Bucket.ts";
import { bindS3Credentials } from "./S3CredentialsBinding.ts";

export { isS3Credentials } from "./S3CredentialsBinding.ts";

/** Which object operations the credentials' API token is granted. */
export type S3CredentialsAccess = "read" | "write" | "read-write";

export interface S3CredentialsOptions {
  /**
   * Object operations the credentials may perform. Deployed, this selects
   * the permission groups of the scoped API token they are derived from
   * (`Workers R2 Storage Read` and/or `Workers R2 Storage Write`).
   * @default "read-write"
   */
  access?: S3CredentialsAccess;
}

/**
 * S3 API credentials and endpoint for one R2 bucket, as delivered to the
 * Worker. Use them with any S3 client (`aws4fetch`, `@aws-sdk/client-s3`)
 * with path-style addressing: `{endpoint}/{bucketName}/{key}`.
 */
export interface S3CredentialsValue {
  /**
   * S3 endpoint, without the bucket: `https://{accountId}.r2.cloudflarestorage.com`
   * when deployed, `{worker url}/cdn-cgi/local/r2/s3` under `alchemy dev`.
   */
  endpoint: string;
  /** Bucket name — the path segment after the endpoint. */
  bucketName: string;
  /** SigV4 signing region. */
  region: "auto";
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * The value returned by {@link S3Credentials}: declarable on an async
 * Worker's `env` (where it arrives as a JSON string) and `yield*`-able in an
 * Effect-native Worker (where it resolves to a deferred accessor).
 */
export interface S3Credentials extends Effect.Effect<
  Effect.Effect<S3CredentialsValue, never, RuntimeContext>,
  never,
  WorkerEnvironment
> {
  readonly "~alchemy/Kind": "Cloudflare.R2.S3Credentials";
  readonly bucket: Bucket;
  readonly access: S3CredentialsAccess;
}

/**
 * S3 API credentials for an R2 bucket that work unchanged in `alchemy dev`
 * and when deployed — for presigned URLs or any S3 client.
 *
 * The native R2 binding cannot presign or speak the S3 API: that requires S3
 * credentials and R2's S3 endpoint. `S3Credentials` provides both, resolved
 * per mode:
 *
 * - **Deployed** — Alchemy mints a scoped account API token for the Worker
 *   and derives S3 credentials from it (access key id = token id, secret =
 *   SHA-256 of the token value). The endpoint is
 *   `https://{accountId}.r2.cloudflarestorage.com` (`.eu.`/`.fedramp.` for
 *   jurisdictional buckets). The value is injected as a secret.
 * - **`alchemy dev`** — a locally-emulated bucket is served on the Worker's
 *   local S3 endpoint (`{worker url}/cdn-cgi/local/r2/s3`) with fixed local
 *   credentials. No token or cloud call is involved, and objects are shared
 *   with the Worker's native bindings of the bucket.
 *
 * The Effect-native presign bindings (`PresignGetObjectToken`,
 * `PresignPutObjectToken`) are built on it.
 *
 * ### Async Workers
 * **Example:** Presign an upload with aws4fetch
 * ```typescript
 * // alchemy.run.ts
 * const uploads = yield* Cloudflare.R2.Bucket("Uploads");
 * yield* Cloudflare.Worker("Api", {
 *   main: "./src/worker.ts",
 *   env: {
 *     UPLOADS_S3: Cloudflare.R2.S3Credentials(uploads, { access: "write" }),
 *   },
 * });
 *
 * // src/worker.ts
 * import { AwsClient } from "aws4fetch";
 * import type { Cloudflare } from "alchemy";
 *
 * export default {
 *   async fetch(request: Request, env: Env) {
 *     const s3: Cloudflare.R2.S3CredentialsValue = JSON.parse(env.UPLOADS_S3);
 *     const client = new AwsClient({ ...s3, service: "s3" });
 *     const url = new URL(`${s3.endpoint}/${encodeURIComponent(s3.bucketName)}/avatar.png`);
 *     url.searchParams.set("X-Amz-Expires", "900");
 *     const signed = await client.sign(url, {
 *       method: "PUT",
 *       aws: { signQuery: true },
 *     });
 *     return Response.json({ url: signed.url });
 *   },
 * };
 * ```
 *
 * ### Effect-native Workers
 * **Example:** Read the credentials at runtime
 * ```typescript
 * const uploads = yield* Uploads;
 * const credentials = yield* Cloudflare.R2.S3Credentials(uploads);
 * // inside a handler:
 * const { endpoint, bucketName, accessKeyId, secretAccessKey } =
 *   yield* credentials;
 * ```
 *
 * @binding
 * @product R2
 * @category Storage & Databases
 */
export const S3Credentials = (
  bucket: Bucket,
  options: S3CredentialsOptions = {},
): S3Credentials => {
  const access = options.access ?? "read-write";
  return Object.assign(
    Effect.gen(function* () {
      const host = yield* CoreBinding.Host;
      return yield* makeS3Credentials(
        isWorker(host) ? host : undefined,
        yield* WorkerEnvironment,
        bucket,
        access,
      );
    }),
    {
      "~alchemy/Kind": "Cloudflare.R2.S3Credentials" as const,
      bucket,
      access,
    },
  );
};

/**
 * Bind {@link S3Credentials} for `bucket` on `host` (deploy time) and return
 * the runtime accessor. `host` is only read at deploy time; it is
 * `undefined` inside the deployed Worker.
 *
 * NOT exported from `index.ts`.
 */
export const makeS3Credentials = (
  host: Worker | undefined,
  env: WorkerEnvironment["Service"],
  bucket: Bucket,
  access: S3CredentialsAccess,
) =>
  Effect.gen(function* () {
    const bindingName = sanitizeKey(
      `R2_S3_CREDENTIALS_${bucket.LogicalId}_${access}`,
    ).toUpperCase();
    if (!globalThis.__ALCHEMY_RUNTIME__) {
      if (host === undefined) {
        return yield* Effect.die(
          new Error(
            `Cloudflare.R2.S3Credentials(${bucket.LogicalId}) can only be bound to a Cloudflare Worker.`,
          ),
        );
      }
      // Deploy-time only; its requirements (CloudflareEnvironment, the
      // token provider) are ambient wherever a Worker is evaluated, so they
      // are erased like `Binding.Host`'s.
      yield* bindS3Credentials(
        host,
        bindingName,
        bucket,
        access,
      ) as Effect.Effect<void>;
    }
    // Captured at init; read at exec phase, where it is populated.
    return Effect.suspend(() => {
      const raw = (env as Record<string, unknown>)[bindingName];
      return typeof raw === "string"
        ? Effect.succeed(JSON.parse(raw) as S3CredentialsValue)
        : Effect.die(
            new Error(
              `Cloudflare.R2.S3Credentials(${bucket.LogicalId}) is not bound to this Worker: missing "${bindingName}".`,
            ),
          );
    }) as Effect.Effect<S3CredentialsValue, never, RuntimeContext>;
  });
