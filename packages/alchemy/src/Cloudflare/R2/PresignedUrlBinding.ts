/**
 * Worker-binding implementation of {@link PresignedUrl}.
 *
 * Deploy-time: registers the bucket as `r2_bucket` and four env
 * bindings (`R2_PRESIGN_*`) on the host Worker.
 *
 * Runtime: the Worker reads the four bindings from `env` and signs
 * URLs locally with `aws4fetch.AwsV4Signer` (Web Crypto, works in
 * workerd). No API call to R2 or Cloudflare.
 */

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Output from "../../Output.ts";
import { Worker, WorkerEnvironment } from "../Workers/Worker.ts";
import {
  readR2PresignEnvCredentials,
  R2_PRESIGN_ACCESS_KEY_ID_BINDING,
  R2_PRESIGN_ACCOUNT_ID_BINDING,
  R2_PRESIGN_BUCKET_NAME_BINDING,
  R2_PRESIGN_SECRET_ACCESS_KEY_BINDING,
} from "./R2PresignAuth.ts";
import { PresignedUrl, type PresignedUrlService } from "./PresignedUrl.ts";
import {
  makePresignedUrlClient,
  type PresignedUrlClient,
} from "./PresignedUrlCore.ts";
import type { Bucket } from "./Bucket.ts";

export const PresignedUrlBinding: Layer.Layer<
  PresignedUrlService,
  never,
  Worker | WorkerEnvironment
> = Layer.effect(
  PresignedUrl,
  Effect.gen(function* () {
    const host = yield* Worker;
    const env = yield* WorkerEnvironment;
    const credentials = yield* Effect.orDie(readR2PresignEnvCredentials());

    return Effect.fn(function* (bucket: Bucket) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* host.bind`${bucket}`({
          bindings: [
            {
              type: "r2_bucket",
              name: bucket.LogicalId,
              bucketName: bucket.bucketName,
              jurisdiction: bucket.jurisdiction.pipe(
                Output.map((j) => (j === "default" ? undefined : j)),
              ),
            },
            {
              type: "plain_text",
              name: R2_PRESIGN_ACCESS_KEY_ID_BINDING,
              text: credentials.accessKeyId,
            },
            {
              type: "secret_text",
              name: R2_PRESIGN_SECRET_ACCESS_KEY_BINDING,
              text: Redacted.value(credentials.secretAccessKey),
            },
            {
              type: "plain_text",
              name: R2_PRESIGN_ACCOUNT_ID_BINDING,
              text: credentials.accountId,
            },
            {
              type: "plain_text",
              name: R2_PRESIGN_BUCKET_NAME_BINDING,
              text: bucket.bucketName,
            },
          ],
        });
      }
      const bucketName = readBindingString(env, R2_PRESIGN_BUCKET_NAME_BINDING);
      return makePresignedUrlClient(credentials, bucketName);
    });
  }),
);

const readBindingString = (
  env: Record<string, unknown>,
  name: string,
): string => {
  const value = env[name] as unknown;
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "get" in (value as object)) {
    // secret_text bindings arrive as `{ get(): Promise<string> }`. Tests
    // inject the string directly; production never hits this branch
    // because the async helper below is used in fetch handlers.
    return "";
  }
  return "";
};

async function readBindingStringAsync(
  env: Record<string, unknown>,
  name: string,
): Promise<string> {
  const value = env[name] as unknown;
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "get" in (value as object)) {
    return String(await (value as { get: () => Promise<string> }).get());
  }
  return "";
}

/**
 * Resolve a fully-wired `PresignedUrlClient` from the Worker's `env`
 * at fetch-handler time. Use this inside `fetch` handlers when the
 * Worker is async (non-Effect-native) and can't bind
 * `Cloudflare.R2.PresignedUrl` in its init phase.
 */
export const runtimePresignedUrlClientFromEnv = async (
  env: Record<string, unknown>,
): Promise<PresignedUrlClient> => {
  const [accessKeyId, secretAccessKey, accountId, bucketName] =
    await Promise.all([
      readBindingStringAsync(env, R2_PRESIGN_ACCESS_KEY_ID_BINDING),
      readBindingStringAsync(env, R2_PRESIGN_SECRET_ACCESS_KEY_BINDING),
      readBindingStringAsync(env, R2_PRESIGN_ACCOUNT_ID_BINDING),
      readBindingStringAsync(env, R2_PRESIGN_BUCKET_NAME_BINDING),
    ]);
  return makePresignedUrlClient(
    {
      accessKeyId,
      secretAccessKey: Redacted.make(secretAccessKey),
      accountId,
    },
    bucketName,
  );
};
