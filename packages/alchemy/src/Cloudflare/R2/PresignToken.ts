import * as SigV4 from "@distilled.cloud/aws/SigV4";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { AlchemyContext } from "../../AlchemyContext.ts";
import * as Output from "../../Output.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import { sanitizeKey } from "../../RuntimeContext.ts";
import { Self } from "../../Self.ts";
import { AccountApiToken } from "../ApiToken/AccountApiToken.ts";
import type { PermissionGroupRef } from "../ApiToken/Common.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import { Worker, WorkerEnvironment } from "../Workers/Worker.ts";
import type { Bucket } from "./Bucket.ts";
import type { PresignError } from "./BucketTypes.ts";
import { LOCAL_R2_S3_CREDENTIALS, LOCAL_R2_S3_PATH } from "./LocalS3.ts";

/**
 * Shared scaffolding for the R2 presign bindings (`PresignGetObjectToken`,
 * `PresignPutObjectToken`).
 *
 * Presigning is a pure SigV4 computation against R2's S3-compatible API, so
 * the Worker only needs S3 credentials and an endpoint, resolved per mode:
 *
 * - **live** — mints a scoped {@link AccountApiToken} (shared with the
 *   Worker's other R2 HTTP bindings). R2 derives S3 credentials from any API
 *   token: the access key id is the token id and the secret access key is
 *   the SHA-256 of the token value. The endpoint is
 *   `https://{accountId}[.{jurisdiction}].r2.cloudflarestorage.com`.
 * - **local** (`alchemy dev`, `dev:` bucket) — binds the bucket onto this
 *   Worker's dev runtime, which serves it on its local S3 endpoint
 *   (`{worker url}/cdn-cgi/local/r2/s3`) with fixed local credentials. No
 *   token or cloud call is involved.
 *
 * The resolved target is injected as one secret env value, so the runtime
 * half reads the same key in both modes.
 *
 * NOT exported from `index.ts`.
 */
export const makePresignBinding = <Request>(options: {
  permissionGroups: PermissionGroupRef[];
  presign: (
    target: PresignTarget,
    request: Request,
  ) => Effect.Effect<string, PresignError>;
  name: string;
}) =>
  Effect.gen(function* () {
    const Token = yield* AccountApiToken;
    const self = yield* Self;
    const host = yield* Worker;
    const cloudflare = yield* CloudflareEnvironment;
    // Captured at init; read at exec phase, where it is populated.
    const env = yield* WorkerEnvironment;

    return Effect.fn(function* (bucket: Bucket) {
      const configKey = sanitizeKey(`R2_PRESIGN_${bucket.LogicalId}`);
      const originKey = sanitizeKey(`R2_PRESIGN_ORIGIN_${bucket.LogicalId}`);

      let config: Output.Output<Redacted.Redacted<string>> = Output.literal(
        Redacted.make(""),
      );
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        if (yield* isLocalBucket(bucket)) {
          yield* host.bind`R2Presign(${bucket})`({
            bindings: [
              // The S3 endpoint is hosted per dev runtime, so the bucket
              // must be bound on this Worker for its URLs to resolve here.
              {
                type: "r2_bucket",
                name: sanitizeKey(`R2_PRESIGN_BUCKET_${bucket.LogicalId}`),
                bucketName: bucket.bucketName,
              },
              { type: "self_url", name: originKey },
            ],
          });
          config = bucket.bucketName.pipe(
            Output.map((bucketName) =>
              encodeConfig({ mode: "local", bucketName }),
            ),
          );
        } else {
          const { accountId } = yield* cloudflare;
          const token = yield* Token(`${self.LogicalId}Token`);
          // One binding id per capability: bindings sharing an id collapse to
          // one, which would drop PresignPut's write grant when PresignGet
          // binds the same bucket (and vice versa).
          yield* token.bind`${options.name}(${bucket.LogicalId})`({
            policies: [
              {
                effect: "allow",
                permissionGroups: options.permissionGroups,
                resources: {
                  [`com.cloudflare.api.account.${accountId}`]: "*",
                },
              },
            ],
          });
          config = Output.all(
            token.tokenId,
            token.value,
            bucket.bucketName,
            bucket.jurisdiction,
          ).pipe(
            Output.map(([tokenId, value, bucketName, jurisdiction]) =>
              encodeConfig({
                mode: "live",
                bucketName,
                endpoint: liveEndpoint(accountId, jurisdiction),
                accessKeyId: tokenId,
                token: Redacted.value(value),
              }),
            ),
          );
        }
      }
      // An explicit key (rather than `yield* config`, keyed by the
      // expression's text) so plan and runtime agree even though the runtime
      // half never builds the plan-time expression. Like `yield* output`, the
      // RuntimeContext requirement is erased: binding init always runs with
      // the host's runtime context.
      const readConfig = yield* config.bind(configKey) as Effect.Effect<
        Effect.Effect<Redacted.Redacted<string> | undefined>
      >;

      const resolveTarget = Effect.gen(function* () {
        const raw = yield* readConfig;
        const decoded =
          raw === undefined ? undefined : decodeConfig(Redacted.value(raw));
        if (decoded === undefined) {
          return yield* Effect.die(
            new Error(
              `${options.name}(${bucket.LogicalId}) is not bound to this Worker: missing "${configKey}".`,
            ),
          );
        }
        if (decoded.mode === "local") {
          const origin = (env as Record<string, string | undefined>)[originKey];
          if (origin === undefined) {
            return yield* Effect.die(
              new Error(
                `${options.name}(${bucket.LogicalId}) is missing its local S3 origin "${originKey}".`,
              ),
            );
          }
          return {
            bucketName: decoded.bucketName,
            endpoint: `${origin.replace(/\/+$/, "")}${LOCAL_R2_S3_PATH}`,
            accessKeyId: LOCAL_R2_S3_CREDENTIALS.accessKeyId,
            secretAccessKey: LOCAL_R2_S3_CREDENTIALS.secretAccessKey,
          } satisfies PresignTarget;
        }
        return {
          bucketName: decoded.bucketName,
          endpoint: decoded.endpoint,
          accessKeyId: decoded.accessKeyId,
          secretAccessKey: yield* sha256Hex(decoded.token),
        } satisfies PresignTarget;
      });

      return Effect.fn(`${options.name}(${bucket.LogicalId})`)(function* (
        request: Request,
      ) {
        const target = yield* resolveTarget;
        return yield* options.presign(target, request);
      }) as (
        request: Request,
      ) => Effect.Effect<string, PresignError, RuntimeContext>;
    });
  });

/** Endpoint, bucket, and S3 credentials a presigned URL is signed for. */
export interface PresignTarget {
  bucketName: string;
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface PresignR2UrlOptions {
  method: "GET" | "PUT";
  key: string;
  /** @default 900 */
  expiresIn?: number;
  /** Headers the consumer must send verbatim (signed into the URL). */
  headers?: Record<string, string>;
  /** Extra query parameters signed into the URL (e.g. `response-content-type`). */
  query?: Record<string, string>;
}

/**
 * Presign a path-style R2 object URL (`{endpoint}/{bucket}/{key}`, region
 * `auto`) for a resolved {@link PresignTarget}. Pure SigV4 — no request is
 * made.
 */
export const presignR2Url = (
  target: PresignTarget,
  options: PresignR2UrlOptions,
): Effect.Effect<string, PresignError> =>
  Effect.gen(function* () {
    const key = options.key.split("/").map(encodeURIComponent).join("/");
    const url = new URL(
      `${target.endpoint.replace(/\/+$/, "")}/${encodeURIComponent(target.bucketName)}/${key}`,
    );
    for (const [name, value] of Object.entries(options.query ?? {})) {
      url.searchParams.set(name, value);
    }
    url.searchParams.set("X-Amz-Expires", String(options.expiresIn ?? 900));
    const signed = yield* SigV4.sign({
      method: options.method,
      url: url.toString(),
      headers: options.headers,
      accessKeyId: target.accessKeyId,
      secretAccessKey: Redacted.make(target.secretAccessKey),
      service: "s3",
      region: "auto",
      signQuery: true,
      // Pin explicitly passed headers (e.g. content-type) into the signature
      allHeaders: options.headers !== undefined,
    });
    return signed.url;
  });

type PresignConfig =
  | { mode: "local"; bucketName: string }
  | {
      mode: "live";
      bucketName: string;
      endpoint: string;
      accessKeyId: string;
      token: string;
    };

const encodeConfig = (config: PresignConfig): Redacted.Redacted<string> =>
  Redacted.make(JSON.stringify(config));

const decodeConfig = (raw: string): PresignConfig | undefined => {
  if (raw === "") return undefined;
  try {
    return JSON.parse(raw) as PresignConfig;
  } catch {
    return undefined;
  }
};

const liveEndpoint = (
  accountId: string,
  jurisdiction: Bucket.Jurisdiction,
): string =>
  jurisdiction === "default"
    ? `https://${accountId}.r2.cloudflarestorage.com`
    : `https://${accountId}.${jurisdiction}.r2.cloudflarestorage.com`;

/**
 * Whether the bucket is emulated locally in this run: pinned via
 * `Alchemy.remote()` → live; otherwise the run default (`alchemy dev` →
 * local).
 */
const isLocalBucket = (bucket: Bucket) =>
  Effect.gen(function* () {
    if (bucket.Mode !== undefined) return bucket.Mode === "local";
    const context = yield* Effect.serviceOption(AlchemyContext);
    return Option.isSome(context) && context.value.dev;
  });

const sha256Hex = (value: string) =>
  Effect.promise(() =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  ).pipe(
    Effect.map((digest) =>
      Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join(""),
    ),
  );
