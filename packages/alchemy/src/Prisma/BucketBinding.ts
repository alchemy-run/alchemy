import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Binding from "../Binding.ts";
import * as Output from "../Output.ts";
import type { Resource, ResourceLike } from "../Resource.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { Bucket } from "./Bucket.ts";
import type { BucketCredentials } from "./BucketTypes.ts";
import { BucketKey } from "./BucketKey.ts";
import { envName } from "./Internal/EnvName.ts";
import type { BucketKeyRole } from "./Types.ts";

/**
 * Access level a bucket binding grants. The three levels are separate
 * {@link Binding.Service}s so a Function can ask for the least privilege it
 * needs; see the role caveat on {@link makeBucketBinding}.
 */
export type BucketCapability = "Read" | "Write" | "ReadWrite";

/**
 * Env var names a bucket binding uses to carry its bucket key into the host
 * runtime.
 */
export interface BucketEnvKeys {
  endpoint: string;
  bucketName: string;
  accessKeyId: string;
  secretAccessKey: string;
}

const CAPABILITY_ENV_SEGMENT: Record<BucketCapability, string> = {
  Read: "READ",
  Write: "WRITE",
  ReadWrite: "READ_WRITE",
};

/**
 * Derive the env var names a bucket binding uses to carry the S3 credentials
 * of a {@link BucketKey} into the host runtime.
 *
 * The access level is part of the prefix because binding the same bucket at
 * two levels mints two distinct keys, and both sets of credentials have to
 * survive in the same environment.
 */
export const bucketEnvKeys = (
  bucket: Pick<Bucket, "FQN" | "LogicalId">,
  capability: BucketCapability,
): BucketEnvKeys => {
  const name = bucket.FQN === bucket.LogicalId ? bucket.LogicalId : bucket.FQN;
  const prefix = `PRISMA_${envName(name)}_${CAPABILITY_ENV_SEGMENT[capability]}`;
  return {
    endpoint: `${prefix}_ENDPOINT`,
    bucketName: `${prefix}_BUCKET_NAME`,
    accessKeyId: `${prefix}_ACCESS_KEY_ID`,
    secretAccessKey: `${prefix}_SECRET_ACCESS_KEY`,
  };
};

/**
 * Logical ID of the {@link BucketKey} a bucket binding creates on the caller's
 * behalf.
 *
 * Derived from the bucket and the access level only — deliberately not from
 * the host. The deployed bundle re-runs the same composition code with no host
 * resolved, and it has to arrive at the same identity, or the runtime half
 * would look for credentials under a different name than the deploy-time half
 * wrote them. Two hosts binding the same bucket at the same level therefore
 * share one key, which is the intended outcome: the credentials are identical.
 */
export const bucketKeyLogicalId = (
  bucket: Pick<Bucket, "LogicalId">,
  capability: BucketCapability,
) => `${bucket.LogicalId}${capability}BucketKey`;

type BucketEnvValue = Output.Output<string | Redacted.Redacted<string>>;

type BucketEnvBindingHost = Resource<
  string,
  object | undefined,
  object,
  { env?: Record<string, BucketEnvValue> }
>;

type BucketWorkerTextBinding =
  | { type: "plain_text"; name: string; text: string }
  | { type: "secret_text"; name: string; text: string };

type BucketWorkerBindingHost = Resource<
  "Cloudflare.Worker",
  object | undefined,
  object,
  { bindings?: BucketWorkerTextBinding[] }
>;

const supportsEnvBinding = (
  host: ResourceLike | undefined,
): host is BucketEnvBindingHost =>
  host?.Type === "Prisma.Compute" || host?.Type === "AWS.Lambda.Function";

const supportsWorkerBinding = (
  host: ResourceLike | undefined,
): host is BucketWorkerBindingHost => host?.Type === "Cloudflare.Worker";

const bucketKeyOutputs = (key: BucketKey) => ({
  endpoint: key.endpoint,
  bucketName: key.bucketName,
  accessKeyId: key.accessKeyId,
  secretAccessKey: key.secretAccessKey,
});

const bucketEnv = (keys: BucketEnvKeys, key: BucketKey) => {
  const outputs = bucketKeyOutputs(key);
  return {
    [keys.endpoint]: outputs.endpoint,
    [keys.bucketName]: outputs.bucketName,
    [keys.accessKeyId]: outputs.accessKeyId,
    [keys.secretAccessKey]: outputs.secretAccessKey,
  };
};

const workerBindingValue = (
  name: string,
  value: BucketEnvValue,
): Output.Output<BucketWorkerTextBinding> =>
  value.pipe(
    Output.map((resolved) =>
      Redacted.isRedacted(resolved)
        ? { type: "secret_text", name, text: Redacted.value(resolved) }
        : { type: "plain_text", name, text: resolved },
    ),
  );

const bucketWorkerBindings = (
  keys: BucketEnvKeys,
  key: BucketKey,
): Output.Output<BucketWorkerTextBinding>[] => {
  const env = bucketEnv(keys, key);
  return Object.entries(env).map(([name, value]) =>
    workerBindingValue(name, value),
  );
};

const runtimeOutput = <A>(
  key: string,
  output: Output.Output<A>,
): Effect.Effect<A, never, RuntimeContext> =>
  output.bind(key).pipe(Effect.flatMap((effect) => effect));

/**
 * {@link runtimeOutput} for the secret: hosts deliver env values as plain
 * strings (Prisma Compute env rows and Cloudflare `secret_text` both carry
 * the unwrapped value), so the `Redacted` wrapper does not survive the trip
 * and must be rebuilt at the read — the same shape as `Connect`'s runtime
 * accessors.
 */
const runtimeSecret = (
  key: string,
  output: Output.Output<Redacted.Redacted<string>>,
): Effect.Effect<Redacted.Redacted<string>, never, RuntimeContext> =>
  runtimeOutput(key, output).pipe(
    Effect.map((value) =>
      Redacted.isRedacted(value) ? value : Redacted.make(String(value)),
    ),
  );

/**
 * Read the bucket key's values back out of the host environment.
 */
export const bucketCredentials = (
  keys: BucketEnvKeys,
  key: BucketKey,
): BucketCredentials => {
  const outputs = bucketKeyOutputs(key);
  return {
    endpoint: runtimeOutput(keys.endpoint, outputs.endpoint),
    bucketName: runtimeOutput(keys.bucketName, outputs.bucketName),
    accessKeyId: runtimeOutput(keys.accessKeyId, outputs.accessKeyId),
    secretAccessKey: runtimeSecret(
      keys.secretAccessKey,
      outputs.secretAccessKey,
    ),
  };
};

/**
 * Shared provisioning half of the Prisma Object Store bindings, and the seam
 * an embedder reuses when it wants the credential and env-var wiring without
 * Alchemy's runtime client: `makeClient` receives the resolved credentials and
 * knows nothing about where they came from.
 *
 * Binding a bucket creates a {@link BucketKey} for it — the logical ID is
 * derived from the bucket and the access level (see
 * {@link bucketKeyLogicalId}), so repeated binds reconcile onto the same key
 * instead of minting a new credential every deploy — and carries the key's
 * endpoint, provider-side bucket name, access key ID, and secret access key
 * into the host under the names {@link bucketEnvKeys} derives.
 *
 * Supported hosts are Prisma Compute and AWS Lambda (env vars) and Cloudflare
 * Workers (text bindings). Any other host dies with a message naming the three.
 *
 * **Role caveat.** Prisma bucket keys carry one of two coarse roles, `read`
 * and `read_write`; there is no write-only role. A `Read` binding mints a
 * `read` key and is genuinely scoped, but a `Write` binding mints a
 * `read_write` key, so its credential can also read. The split between `Write`
 * and `ReadWrite` is therefore a forward contract enforced client-side — the
 * `Write` client exposes no read operations — and it becomes an enforced
 * server-side boundary if Prisma grows a write-only role.
 */
export const makeBucketBinding = <Client>(options: {
  /** Access level this binding grants; part of the key identity and env names. */
  capability: BucketCapability;
  /** Role to mint the bucket key with. */
  role: BucketKeyRole;
  /** Build the runtime client from the resolved bucket key credentials. */
  makeClient: (credentials: BucketCredentials) => Client;
}) =>
  Effect.gen(function* () {
    const Key = yield* BucketKey;

    return Effect.fn(function* (bucket: Bucket) {
      const key = yield* Key(bucketKeyLogicalId(bucket, options.capability), {
        bucket,
        role: options.role,
      });
      const keys = bucketEnvKeys(bucket, options.capability);
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        const tag = `Prisma.${options.capability}Bucket`;
        if (supportsEnvBinding(host)) {
          yield* host.bind`${tag}(${bucket})`({ env: bucketEnv(keys, key) });
        } else if (supportsWorkerBinding(host)) {
          yield* host.bind`${tag}(${bucket})`({
            bindings: bucketWorkerBindings(keys, key),
          });
        } else {
          return yield* Effect.die(
            new Error(
              `Prisma.${options.capability}Bucket supports Prisma.Compute, AWS.Lambda.Function, and Cloudflare.Worker runtimes, got '${host?.Type ?? "no host"}'`,
            ),
          );
        }
      }
      return options.makeClient(bucketCredentials(keys, key));
    });
  });
