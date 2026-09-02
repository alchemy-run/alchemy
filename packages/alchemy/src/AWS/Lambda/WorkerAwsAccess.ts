/**
 * How a **Cloudflare Worker** reaches AWS (DESIGN: cross-cloud bindings).
 *
 * A Worker has no execution role, so binding an AWS operation to one makes
 * Alchemy provision — once per host — an IAM User + AccessKey + a
 * least-privilege assume-role Role, bind the key and role ARN onto the
 * Worker, and assume the role at runtime through a single-flight,
 * expiry-aware resolver shared by every binding on that host. Both the
 * MicroVM `*Http` family and the function-scoped Lambda `*Http` bindings
 * (`InvokeFunctionHttp`, …) use this. NOT exported from `index.ts`.
 */
import type {
  AwsCredentialProviderError,
  ResolvedCredentials,
} from "@distilled.cloud/aws/Credentials";
import * as Endpoint from "@distilled.cloud/aws/Endpoint";
import { Region } from "@distilled.cloud/aws/Region";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { AlchemyContext } from "../../AlchemyContext.ts";
import type { Input } from "../../Input.ts";
import type { ResourceLike } from "../../Resource.ts";
import { DEFAULT_LOCAL_ENDPOINT } from "../AuthProvider.ts";
import { Credentials, makeAssumeRoleResolver } from "../Credentials.ts";
import { AccessKey } from "../IAM/AccessKey.ts";
import { Role } from "../IAM/Role.ts";
import { User } from "../IAM/User.ts";

// We resolve the host (Worker vs Lambda) at both deploy AND runtime to decide
// how credentials are supplied. A Cloudflare Worker is structurally tagged with
// this Type id; a hard import of the Cloudflare module graph is avoided.
const WORKER_TYPE_ID = "Cloudflare.Worker";
export type WorkerHost = ResourceLike & {
  bind: (
    template: TemplateStringsArray,
    ...args: unknown[]
  ) => (binding: Input<{ bindings?: unknown[] }>) => Effect.Effect<void>;
};
export const isWorkerHost = (host: ResourceLike): host is WorkerHost =>
  (host as { Type?: string }).Type === WORKER_TYPE_ID;

/** Region segment of an AWS ARN (`arn:partition:service:<region>:...`). */
export const regionFromArn = (arn: string): string =>
  arn.split(":")[3] ?? "us-east-1";

// ---------------------------------------------------------------------------
// Per-scope singleton store. A Worker reaching AWS must create exactly ONE IAM
// User + AccessKey + Role (and one assumed-role credential cache) regardless of
// how many of the ~16 MicroVM `*Http` bindings it uses. A
// `WeakMap<Scope, Ref<HashMap>>` memoizes any keyed effect for the lifetime of
// the surrounding scope (the deploy plan, or the worker's runtime init scope),
// so every binding shares the same resources and the same credentials.
// ---------------------------------------------------------------------------

const perScope = new WeakMap<
  Scope.Scope,
  Ref.Ref<HashMap.HashMap<string, unknown>>
>();
// Fallback when no `Scope` is in context — notably a deployed Worker's init
// phase, which runs outside any scope. Process-wide is an acceptable singleton
// granularity there (one isolate == one logical host).
const globalStore = new Map<string, unknown>();

const storeRef = Effect.gen(function* () {
  const scope = yield* Effect.serviceOption(Scope.Scope);
  if (Option.isNone(scope)) return undefined;
  let ref = perScope.get(scope.value);
  if (!ref) {
    ref = yield* Ref.make(HashMap.empty<string, unknown>());
    perScope.set(scope.value, ref);
  }
  return ref;
});

const memoize = <A, E, R>(key: string, build: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const ref = yield* storeRef;
    if (ref) {
      const existing = HashMap.get(yield* Ref.get(ref), key);
      if (Option.isSome(existing)) return existing.value as A;
      const value = yield* build;
      yield* Ref.update(ref, HashMap.set(key, value as unknown));
      return value;
    }
    if (globalStore.has(key)) return globalStore.get(key) as A;
    const value = yield* build;
    globalStore.set(key, value);
    return value;
  }) as Effect.Effect<A, E, R>;

export interface WorkerAwsAccess {
  /** The shared least-privilege Role each binding contributes statements to. */
  readonly role: Role;
  /**
   * Shared assumed-role credentials resolver, single-flight + expiry-aware,
   * built ONCE per host (see {@link ensureWorkerAwsAccess}). Every binding and
   * every request reuses this exact resolver, so `AssumeRole` runs once and is
   * re-run only when the cached credentials approach expiry — never per request.
   */
  readonly credentials: Effect.Effect<
    ResolvedCredentials,
    AwsCredentialProviderError
  >;
}

/**
 * Create — once per scope, per host worker — the IAM identity a Cloudflare
 * Worker uses to reach AWS (the logical ids keep their original `microvm`
 * names: renaming them would replace deployed identities):
 *   - an IAM **User** allowed to assume any role that trusts it,
 *   - a long-lived **AccessKey** for that user,
 *   - a least-privilege **Role** the user assumes (trusts only this user;
 *     MicroVM permissions accumulate on it via `role.bind`).
 *
 * The user's access key + the role ARN are read as {@link Output} *accessors*
 * (`yield* accessKey.accessKeyId`, …) — yielding an attribute both registers
 * the binding on the worker (deploy) and returns an `Effect` that reads it at
 * runtime. At runtime those accessors feed an assume-role credentials layer
 * (single-flight, expiry-aware) built once and shared across all bindings.
 */
export const ensureWorkerAwsAccess = (host: WorkerHost) =>
  memoize(
    `worker-aws:${(host as ResourceLike).LogicalId}`,
    Effect.gen(function* (): Generator<any, WorkerAwsAccess, any> {
      const id = (host as ResourceLike).LogicalId;

      // The user may assume any role that trusts it (Resource `*`); the role's
      // trust policy is what actually restricts assumption to this user, which
      // avoids a User↔Role ARN dependency cycle while staying safe.
      const user = yield* User(`${id}-microvm-user`, {
        inlinePolicies: {
          "assume-microvm-role": {
            Version: "2012-10-17",
            Statement: [
              { Effect: "Allow", Action: ["sts:AssumeRole"], Resource: ["*"] },
            ],
          },
        },
      });

      const accessKey = yield* AccessKey(`${id}-microvm-key`, {
        userName: user.userName,
      });

      const role = yield* Role(`${id}-microvm-role`, {
        assumeRolePolicyDocument: {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: { AWS: user.userArn },
              Action: ["sts:AssumeRole"],
            },
          ],
        },
      });

      // Local dev: the AWS side of this binding runs on the emulator, so the
      // worker's STS AssumeRole and MicroVM calls must too. Bake the
      // LocalStack-standard `AWS_ENDPOINT_URL` into the worker env — the same
      // override the emulator injects into Lambda containers, picked up at
      // runtime by `Endpoint.fromEnv()` in `withRuntimeCredentials`. Deploy
      // runs (dev=false) bind nothing, so live behavior is unchanged.
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const context = yield* Effect.serviceOption(AlchemyContext);
        if (Option.isSome(context) && context.value.dev) {
          yield* host.bind`${id}-microvm-endpoint`({
            bindings: [
              {
                type: "plain_text",
                name: "AWS_ENDPOINT_URL",
                text: DEFAULT_LOCAL_ENDPOINT,
              },
            ],
          });
        }
      }

      // Bind the user's credentials + role ARN onto the worker via accessors:
      // at deploy this registers the env (the secret as `secret_text`); at
      // runtime these resolve to the deployed values.
      const accessKeyId = yield* accessKey.accessKeyId;
      const secretAccessKey = yield* accessKey.secretAccessKey;
      const roleArn = yield* role.roleArn;

      // The long-lived IAM-user credentials that sign `AssumeRole`. Read lazily
      // from the worker environment on each refresh (NOT captured eagerly, so
      // this is valid at deploy time where the env isn't populated yet).
      const base = Layer.succeed(
        Credentials,
        Effect.gen(function* () {
          const id = yield* accessKeyId;
          const secret = yield* secretAccessKey;
          return {
            accessKeyId: Redacted.make(id),
            secretAccessKey: secret
              ? Redacted.isRedacted(secret)
                ? secret
                : Redacted.make(secret)
              : Redacted.make(""),
            sessionToken: undefined,
            // STS AssumeRole is signed against a fixed global endpoint region;
            // per-request operations provide their own image-derived Region.
            region: "us-east-1",
          } satisfies ResolvedCredentials;
        }),
      );

      // Build the single-flight, expiry-aware assume-role cache ONCE. STS is
      // global, so the endpoint region is a fixed default; the per-request
      // operation provides its own image-derived `Region` separately.
      const credentials = yield* makeAssumeRoleResolver({
        roleArn,
        base,
        region: "us-east-1",
      });

      return { role, credentials };
    }),
  );

/**
 * Run a MicroVM operation with host-appropriate AWS credentials:
 * - Lambda Function host → the execution-role credentials already in the
 *   ambient environment (nothing to provide).
 * - Cloudflare Worker host → the assumed-role credentials, plus a `Region`
 *   derived from the image ARN and an `HttpClient`.
 */
export const withRuntimeCredentials = <A, E>(
  access: WorkerAwsAccess | undefined,
  region: Effect.Effect<string>,
  eff: Effect.Effect<A, E, any>,
): Effect.Effect<A, E, any> =>
  access
    ? Effect.gen(function* () {
        const reg = yield* region;
        // Provide the SHARED cached resolver built once in
        // `ensureWorkerAwsAccess` — NOT a fresh assume-role layer per request —
        // so the assumed-role credentials are reused (and only refreshed near
        // expiry) instead of re-assuming the role on every call.
        return yield* eff.pipe(
          Effect.provide(
            Layer.succeed(Credentials, access.credentials).pipe(
              Layer.provideMerge(Layer.succeed(Region, Effect.succeed(reg))),
              // `AWS_ENDPOINT_URL` from the worker env (bound under local
              // dev by `ensureWorkerAwsAccess`); resolves undefined when
              // unset, so live workers keep the real AWS endpoints. The
              // shared assume-role resolver also reads this ambient
              // Endpoint for its STS call.
              Layer.provideMerge(Endpoint.fromEnv()),
              Layer.provideMerge(FetchHttpClient.layer),
            ),
          ),
        );
      })
    : eff;
