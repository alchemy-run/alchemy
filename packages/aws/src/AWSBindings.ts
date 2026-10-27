import { createHash } from "node:crypto";
import { fromWebToken, type ResolvedCredentials } from "@distilled.cloud/aws/Credentials";
import * as Endpoint from "@distilled.cloud/aws/Endpoint";
import { Region, type RegionName } from "@distilled.cloud/aws/Region";
import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Binding from "alchemy/Binding";
import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import { describeDataPlane, tryFindProviderRegistrationByType } from "alchemy/Provider";
import { remote } from "alchemy/ProviderMode";
import { isResourceOfType, type ResourceLike } from "alchemy/Resource";
import { CurrentRuntimeContext } from "alchemy/RuntimeContext";
import { Stack } from "alchemy/Stack";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import type * as rolldown from "rolldown";
import { DEFAULT_LOCAL_ENDPOINT } from "./AuthProvider.ts";
import { Credentials, makeAssumeRoleResolver } from "./Credentials.ts";
import { AWSEnvironment } from "./Environment.ts";
import { AccessKey } from "./IAM/AccessKey.ts";
import type { PolicyStatement } from "./IAM/Policy.ts";
import { Role } from "./IAM/Role.ts";
import { User } from "./IAM/User.ts";
import { CurrentRegion } from "./Region.ts";

/**
 * How an AWS binding reaches AWS from its host:
 *
 * - the host runs as an IAM role (Lambda, ECS, EC2, …): statements go on that
 *   role, and calls use its ambient credentials;
 * - the host runs as a Google service account (Cloud Run, Cloud Functions):
 *   Alchemy creates a Role that trusts that account's Google ID tokens, puts
 *   the statements on the Role, and the host assumes it with
 *   `AssumeRoleWithWebIdentity`. No key is created;
 * - any other host (a Cloudflare Worker, Cloud Run, a GKE pod): Alchemy
 *   creates an IAM User and AccessKey that may assume a Role, puts the
 *   statements on the Role, and binds the key into the host's env;
 * - a host emulated by `alchemy dev` that binds a resource in the real cloud
 *   (`Alchemy.remote()`): its role exists only on the emulator, so Alchemy
 *   creates a live IAM User, AccessKey and Role for it, and that binding's
 *   calls sign with the key against the real endpoint;
 * - no host (a script or deploy-time Action): nothing is bound and calls use
 *   the deployer's credentials.
 *
 * Import it as a namespace. A binding resolves its operations with
 * {@link withCredentials} and gets its `bind` from {@link Bind} when its layer
 * is built, then binds behind its own `__ALCHEMY_RUNTIME__` guard:
 *
 * ```ts
 * Effect.gen(function* () {
 *   const sendMessage = yield* AWSBindings.withCredentials(sqs.sendMessage);
 *   const bind = yield* AWSBindings.Bind;
 *   return Effect.fn(function* (queue: Queue) {
 *     if (!globalThis.__ALCHEMY_RUNTIME__) {
 *       yield* bind`AWS.SQS.SendMessage(${queue})`({
 *         policyStatements: [
 *           { Effect: "Allow", Action: ["sqs:SendMessage"], Resource: [queue.queueArn] },
 *         ],
 *       });
 *     }
 *     return (request) => sendMessage({ ...request, QueueUrl: … });
 *   });
 * })
 * ```
 */

/** What a binding attaches to its host. */
export interface HostBinding {
  /** The IAM statements the binding needs. */
  readonly policyStatements?: Input<PolicyStatement>[];
  /** Env vars the binding reads at runtime. */
  readonly env?: Record<string, unknown>;
}

/** The VPC a host must attach to, e.g. to reach a VPC-only database. */
export interface HostVpc {
  readonly subnetIds: Input<string[]>;
  readonly securityGroupIds: Input<string[]>;
}

/**
 * Build options for a bundle that runs on a host running as an IAM role (Lambda, ECS, EC2, AppRunner, Batch, EKS): defines
 * `__ALCHEMY_HOST_IDENTITY__` as `"AWS.IAM.Role"` so the bundler drops the created-key credentials path.
 */
export const roleHostBundle = (input: rolldown.InputOptions): rolldown.InputOptions => ({
  ...input,
  transform: {
    ...input.transform,
    define: {
      ...input.transform?.define,
      "globalThis.__ALCHEMY_HOST_IDENTITY__": JSON.stringify("AWS.IAM.Role"),
    },
  },
});

/**
 * Env vars holding the key Alchemy creates for a host that doesn't run as an
 * IAM role. Only {@link Bind} sets them, and only on that path, so at
 * runtime their presence is the whole decision.
 */
const KEY_ENV = {
  accessKeyId: "ALCHEMY_AWS_ACCESS_KEY_ID",
  secretAccessKey: "ALCHEMY_AWS_SECRET_ACCESS_KEY",
  roleArn: "ALCHEMY_AWS_ROLE_ARN",
  region: "ALCHEMY_AWS_REGION",
} as const;

/**
 * Env vars holding the key Alchemy creates in the real cloud for a host
 * emulated by `alchemy dev` that binds an `Alchemy.remote()` (or otherwise
 * live) resource: the host's own role exists only on the emulator, so it
 * cannot reach that resource. Separate from {@link KEY_ENV} so the
 * host's emulator identity keeps serving its local bindings.
 */
const REMOTE_KEY_ENV = {
  accessKeyId: "ALCHEMY_AWS_REMOTE_ACCESS_KEY_ID",
  secretAccessKey: "ALCHEMY_AWS_REMOTE_SECRET_ACCESS_KEY",
  roleArn: "ALCHEMY_AWS_REMOTE_ROLE_ARN",
  region: "ALCHEMY_AWS_REMOTE_REGION",
} as const;

/**
 * Env var marking a bound resource as living in the real cloud while its
 * host is emulated: its binding clients sign with {@link REMOTE_KEY_ENV} and
 * skip the emulator endpoint. Keyed by a hash of the resource's FQN.
 */
const remoteMarker = (resource: ResourceLike) =>
  Effect.sync(
    () =>
      `ALCHEMY_AWS_REMOTE_${createHash("sha256").update(resource.FQN).digest("hex").slice(0, 12)}`,
  );

/**
 * Env var holding the Role a Google-service-account host assumes with its
 * ID token. Only {@link Bind} sets it, on that path only.
 */
const WEB_IDENTITY_ROLE_ENV = "ALCHEMY_AWS_WEB_IDENTITY_ROLE_ARN";

/** The `aud` a host requests on the Google ID tokens it exchanges with STS. */
const GOOGLE_ID_TOKEN_AUDIENCE = "sts.amazonaws.com";

/**
 * Whether a host runs its code as an IAM role: Lambda, ECS, EC2,
 * AutoScaling, AppRunner, Batch, or a Kubernetes workload on an EKS cluster
 * (Pod Identity). Not a Lambda `MicrovmImage`: an image has no role of its
 * own (`RunMicrovm` takes one per launch). Deploy-time only: it reads the
 * host's props.
 */
export const runsAsRole = (host: ResourceLike): boolean => {
  switch (host.Type) {
    case "AWS.Lambda.Function":
    case "AWS.Lambda.WebFunction":
    case "AWS.ECS.Task":
    case "AWS.ECS.Service":
    case "AWS.EC2.Instance":
    case "AWS.AutoScaling.LaunchTemplate":
    case "AWS.AppRunner.Service":
    case "AWS.Batch.JobDefinition":
      return true;
    case "Kubernetes.Deployment":
    case "Kubernetes.Job":
      return isEksCluster(host.Props?.cluster);
    default:
      return false;
  }
};

/**
 * Whether a host runs its code as a Google service account that can fetch ID
 * tokens from the metadata server: Cloud Run and Cloud Functions. Not a GKE
 * pod: its Workload Identity principal has no ID tokens. Deploy-time only.
 *
 * TODO: don't hard-code GCP host types in the AWS package. The GCP package
 * owns them (and their `serviceAccountUniqueId`); find a way for it to
 * provide this, e.g. as a Layer the AWS binding reads at deploy time.
 */
export const runsAsGoogleServiceAccount = (host: ResourceLike): boolean => {
  switch (host.Type) {
    case "GCP.Run.Service":
    case "GCP.Run.Job":
    case "GCP.Run.WorkerPool":
    case "GCP.CloudFunctions.Function":
      return true;
    default:
      return false;
  }
};

/**
 * The name of the Role a Google-service-account host assumes:
 * `{stack}-{host}-{stage}-` plus a hash of the host's FQN, at most 64
 * characters. Derived from the host alone so the host's env can name the
 * Role without depending on it.
 */
const federatedRoleName = Effect.fn(function* (host: ResourceLike) {
  const stack = yield* Effect.serviceOption(Stack);
  const prefix = Option.isSome(stack)
    ? `${stack.value.name}-${host.LogicalId}-${stack.value.stage}-`
    : `${host.LogicalId}-`;
  const hash = yield* Effect.sync(() =>
    createHash("sha256").update(host.FQN).digest("hex").slice(0, 12),
  );
  return `${prefix.replaceAll(/[^a-zA-Z0-9-]/g, "-").slice(0, 64 - hash.length)}${hash}`;
});

/** An `AWS.EKS.Cluster`, or a cluster connection authenticating as `aws-eks`. */
const isEksCluster = (cluster: unknown): boolean => {
  if (isResourceOfType(cluster, "AWS.EKS.Cluster")) return true;
  const value = cluster as { auth?: { kind?: string }; connection?: { auth?: { kind?: string } } };
  return value?.auth?.kind === "aws-eks" || value?.connection?.auth?.kind === "aws-eks";
};

/** Label a binding `<verb>(<host>, <label>)`, as `host.bind` records it. */
const labelled = (verb: string, label: TemplateStringsArray): TemplateStringsArray => {
  const strings = [`${verb}(`, `, ${label[0]}`, ...label.slice(1)];
  strings[strings.length - 1] += ")";
  return Object.assign(strings, { raw: strings }) as unknown as TemplateStringsArray;
};

type BindTarget = {
  bind: (...args: unknown[]) => (data: unknown) => Effect.Effect<void>;
};

const toOutput = (value: unknown) => (Output.isOutput(value) ? value : Output.literal(value));

/**
 * The `bind` for a binding's layer: yield it while the layer is built, then
 * call it from the returned function, behind a literal
 * `if (!globalThis.__ALCHEMY_RUNTIME__)` so the bundler drops it. It attaches
 * the binding to its host labelled `Allow(<host>, <label>)`:
 *
 * - a host that runs as an IAM role takes the statements on that role;
 * - a host that runs as a Google service account gets a Role that trusts
 *   its ID tokens; the Role takes the statements;
 * - any other host gets an IAM User and AccessKey that may assume a Role;
 *   the Role takes the statements and the key is bound into the host's env.
 *
 * ```ts
 * Effect.gen(function* () {
 *   const bind = yield* AWSBindings.Bind;
 *   return Effect.fn(function* (queue: Queue) {
 *     if (!globalThis.__ALCHEMY_RUNTIME__) {
 *       yield* bind`AWS.SQS.SendMessage(${queue})`({ policyStatements: [ … ] });
 *     }
 *   });
 * })
 * ```
 */
/** The signature {@link Bind} yields. */
export type BindHost = (
  label: TemplateStringsArray,
  ...args: unknown[]
) => (data: HostBinding) => Effect.Effect<void>;

export const Bind: Effect.Effect<BindHost> = Effect.gen(function* () {
  // Bindings only bind at deploy, so a host bundle captures nothing here
  // and drops the identity resources.
  if (globalThis.__ALCHEMY_RUNTIME__) return () => () => Effect.void;
  const IamUser = yield* User;
  const IamAccessKey = yield* AccessKey;
  const IamRole = yield* Role;

  return (label: TemplateStringsArray, ...args: unknown[]) =>
    Effect.fn(function* (data: HostBinding) {
      const host = yield* Binding.Host;
      if (host === undefined) return;

      if (runsAsRole(host)) {
        if (yield* isRemoteFromLocalHost(host)) {
          return yield* bindRemote(host, label, args, data);
        }
        return yield* (host as unknown as BindTarget).bind(
          labelled("Allow", label),
          host,
          ...args,
        )(data);
      }

      const id = host.LogicalId;
      const runtime = (yield* CurrentRuntimeContext)!;

      if (runsAsGoogleServiceAccount(host)) {
        // The host's env names the Role by a name derived from the host, not
        // by the Role's output: the Role's trust reads the host's service
        // account, so an env reference back to the Role would be a cycle.
        const roleName = yield* federatedRoleName(host);
        const uniqueId = (host as unknown as { serviceAccountUniqueId: Output.Output<string> })
          .serviceAccountUniqueId;
        const role = yield* IamRole(`${id}Role`, {
          roleName,
          assumeRolePolicyDocument: {
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Principal: { Federated: "accounts.google.com" },
                Action: ["sts:AssumeRoleWithWebIdentity"],
                Condition: {
                  StringEquals: {
                    // Google ID tokens carry the account's unique ID as
                    // `sub` and `azp`; IAM reads `azp` as `aud` and the
                    // requested audience as `oaud`.
                    "accounts.google.com:sub": uniqueId,
                    "accounts.google.com:aud": uniqueId,
                    "accounts.google.com:oaud": GOOGLE_ID_TOKEN_AUDIENCE,
                  },
                },
              },
            ],
          },
        });
        if (data.policyStatements !== undefined && data.policyStatements.length > 0) {
          yield* (role as unknown as BindTarget).bind(
            labelled("Allow", label),
            host,
            ...args,
          )({ policyStatements: data.policyStatements });
        }
        yield* runtime.set(
          WEB_IDENTITY_ROLE_ENV,
          Output.fromEffect(
            AWSEnvironment.use((env) =>
              Effect.map(env, ({ accountId }) => `arn:aws:iam::${accountId}:role/${roleName}`),
            ).pipe(Effect.orDie),
          ) as Output.Output<string>,
        );
        yield* runtime.set(
          KEY_ENV.region,
          Output.fromEffect(CurrentRegion.pipe(Effect.orDie)) as Output.Output<string>,
        );
        for (const [key, value] of Object.entries(data.env ?? {})) {
          yield* runtime.set(key, toOutput(value));
        }
        return;
      }

      // The user may assume any role that trusts it; the role's trust policy
      // restricts assumption to this user, which avoids a User↔Role ARN cycle.
      const user = yield* IamUser(`${id}User`, {
        inlinePolicies: {
          AssumeRole: {
            Version: "2012-10-17",
            Statement: [{ Effect: "Allow", Action: ["sts:AssumeRole"], Resource: ["*"] }],
          },
        },
      });
      const accessKey = yield* IamAccessKey(`${id}AccessKey`, { userName: user.userName });
      const role = yield* IamRole(`${id}Role`, {
        assumeRolePolicyDocument: {
          Version: "2012-10-17",
          Statement: [
            { Effect: "Allow", Principal: { AWS: user.userArn }, Action: ["sts:AssumeRole"] },
          ],
        },
      });
      if (data.policyStatements !== undefined && data.policyStatements.length > 0) {
        yield* (role as unknown as BindTarget).bind(
          labelled("Allow", label),
          host,
          ...args,
        )({ policyStatements: data.policyStatements });
      }

      yield* runtime.set(KEY_ENV.accessKeyId, accessKey.accessKeyId);
      yield* runtime.set(KEY_ENV.secretAccessKey, accessKey.secretAccessKey);
      yield* runtime.set(KEY_ENV.roleArn, role.roleArn);
      yield* runtime.set(
        KEY_ENV.region,
        Output.fromEffect(CurrentRegion.pipe(Effect.orDie)) as Output.Output<string>,
      );
      // Local dev: STS and the bound operations run on the emulator, reached
      // via the same `AWS_ENDPOINT_URL` the emulator injects into Lambdas.
      const context = yield* Effect.serviceOption(AlchemyContext);
      if (Option.isSome(context) && context.value.dev) {
        yield* runtime.set("AWS_ENDPOINT_URL", Output.literal(DEFAULT_LOCAL_ENDPOINT));
      }
      for (const [key, value] of Object.entries(data.env ?? {})) {
        yield* runtime.set(key, toOutput(value));
      }
    });
});

/**
 * Whether a host emulated by `alchemy dev` binds resources that live in the
 * real cloud (`Alchemy.remote()`, or a provider with no emulator). The host
 * runs as an emulator role that cannot reach them.
 */
const isRemoteFromLocalHost = Effect.fn(function* (host: ResourceLike) {
  if ((yield* describeDataPlane(host)).kind !== "local") return false;
  const targets = yield* Binding.Targets;
  if (targets.length === 0) return false;
  for (const target of targets) {
    const plane = yield* describeDataPlane(target);
    if (plane.kind !== "live" && plane.kind !== "agnostic") return false;
  }
  return true;
});

/**
 * Bind a live resource onto an emulated host: Alchemy creates an IAM User,
 * AccessKey and Role in the real cloud, puts the statements on the Role,
 * binds the key into the host's env, and marks each bound resource so its
 * runtime client signs with that key against the real endpoint.
 */
const bindRemote = Effect.fn(function* (
  host: ResourceLike,
  label: TemplateStringsArray,
  args: unknown[],
  data: HostBinding,
) {
  const runtime = (yield* CurrentRuntimeContext)!;
  const id = host.LogicalId;
  const user = yield* (yield* User)(`${id}RemoteUser`, {
    inlinePolicies: {
      AssumeRole: {
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Action: ["sts:AssumeRole"], Resource: ["*"] }],
      },
    },
  }).pipe(remote());
  const accessKey = yield* (yield* AccessKey)(`${id}RemoteAccessKey`, {
    userName: user.userName,
  }).pipe(remote());
  const role = yield* (yield* Role)(`${id}RemoteRole`, {
    assumeRolePolicyDocument: {
      Version: "2012-10-17",
      Statement: [
        { Effect: "Allow", Principal: { AWS: user.userArn }, Action: ["sts:AssumeRole"] },
      ],
    },
  }).pipe(remote());
  if (data.policyStatements !== undefined && data.policyStatements.length > 0) {
    yield* (role as unknown as BindTarget).bind(
      labelled("Allow", label),
      host,
      ...args,
    )({ policyStatements: data.policyStatements });
  }
  yield* runtime.set(REMOTE_KEY_ENV.accessKeyId, accessKey.accessKeyId);
  yield* runtime.set(REMOTE_KEY_ENV.secretAccessKey, accessKey.secretAccessKey);
  yield* runtime.set(REMOTE_KEY_ENV.roleArn, role.roleArn);
  // The run's ambient region is the emulator's; the live one is what the
  // (always live-pinned) IAM provider was registered with.
  const iam = yield* tryFindProviderRegistrationByType("AWS.IAM.Role");
  const live = Option.flatMapNullishOr(iam, (provider) => provider.liveDataPlane?.());
  yield* runtime.set(
    REMOTE_KEY_ENV.region,
    Output.fromEffect(
      Option.match(live, {
        onNone: () => CurrentRegion,
        onSome: (layer) => CurrentRegion.pipe(Effect.provide(layer)),
      }).pipe(Effect.orDie),
    ) as Output.Output<string>,
  );
  for (const target of yield* Binding.Targets) {
    yield* runtime.set(yield* remoteMarker(target), Output.literal("1"));
  }
  for (const [key, value] of Object.entries(data.env ?? {})) {
    yield* runtime.set(key, toOutput(value));
  }
});

/**
 * Attach the host to a VPC, labelled `Vpc(<host>, <label>)`. Only a host that
 * runs as an IAM role has a VPC to attach; any other host reaches AWS over
 * the internet, so this skips it. Call it behind a literal
 * `if (!globalThis.__ALCHEMY_RUNTIME__)`.
 */
export const bindVpc = (label: TemplateStringsArray, ...args: unknown[]) =>
  Effect.fn(function* (vpc: HostVpc) {
    const host = yield* Binding.Host;
    if (host === undefined || !runsAsRole(host)) return;
    yield* (host as unknown as BindTarget).bind(labelled("Vpc", label), host, ...args)({ vpc });
  });

/**
 * A Google ID token for {@link GOOGLE_ID_TOKEN_AUDIENCE}, fetched from the
 * metadata server as the host's runtime service account. Tokens live an
 * hour; a fresh one is fetched on every credential refresh.
 */
const googleIdToken = Effect.gen(function* () {
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const response = yield* client.execute(
    HttpClientRequest.get(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity",
    ).pipe(
      HttpClientRequest.setHeader("Metadata-Flavor", "Google"),
      HttpClientRequest.setUrlParams({ audience: GOOGLE_ID_TOKEN_AUDIENCE, format: "full" }),
    ),
  );
  return Redacted.make((yield* response.text).trim());
}).pipe(Effect.provide(FetchHttpClient.layer));

/**
 * Resolve an operation on a host that runs as a Google service account: the
 * Role {@link Bind} created for it is assumed with the host's Google ID token
 * (`AssumeRoleWithWebIdentity`). Credentials are cached and re-assumed with a
 * fresh token shortly before they expire.
 */
const withWebIdentity = Effect.fn(function* <Op>(
  operation: Effect.Effect<Op, never, any>,
  region?: Effect.Effect<Effect.Effect<string>, never, any>,
) {
  const runtime = yield* CurrentRuntimeContext;
  const roleArn = runtime ? yield* runtime.get<string>(WEB_IDENTITY_ROLE_ENV) : undefined;
  if (runtime === undefined || roleArn === undefined) {
    return yield* operation as Effect.Effect<Op>;
  }
  const credentials = fromWebToken({
    roleArn,
    webIdentityToken: googleIdToken,
    roleSessionName: "alchemy",
    // STS is global; operations provide their own Region.
    region: "us-east-1",
  });
  const callRegion =
    region !== undefined
      ? yield* region as Effect.Effect<Effect.Effect<string>>
      : Effect.map(runtime.get<string>(KEY_ENV.region), (value) => value ?? "us-east-1");
  return yield* (operation as Effect.Effect<Op>).pipe(
    Effect.provide([
      credentials,
      Layer.succeed(Region, callRegion as Effect.Effect<RegionName>),
      Endpoint.fromEnv(),
      FetchHttpClient.layer,
    ]),
  );
});

/**
 * Resolve a distilled operation (or several, with `Effect.all`) with the
 * host's AWS credentials, once when the binding's layer is built: by
 * assuming the Role {@link Bind} created for this host if there is one,
 * as-is otherwise (the host's own role, or the deployer).
 *
 * @param region the region a host with a created key signs in, e.g. a
 *   bucket's own. Its outer Effect may read resource attributes onto the
 *   host, so it also runs at deploy for those hosts.
 *   @default the stack's region
 */
export const withCredentials: <Op>(
  operation: Effect.Effect<Op, never, any>,
  region?: Effect.Effect<Effect.Effect<string>, never, any>,
) => Effect.Effect<Op> = Effect.fn(function* <Op>(
  operation: Effect.Effect<Op, never, any>,
  region?: Effect.Effect<Effect.Effect<string>, never, any>,
) {
  // An emulated host reaching a live resource signs with the key Alchemy
  // created for it in the real cloud (see `bindRemote`).
  if (globalThis.__ALCHEMY_RUNTIME__) {
    const runtime = yield* CurrentRuntimeContext;
    const targets = yield* Binding.Targets;
    if (runtime !== undefined && targets.length > 0) {
      let remoteTargets = true;
      for (const target of targets) {
        if ((yield* runtime.get<string>(yield* remoteMarker(target))) === undefined) {
          remoteTargets = false;
        }
      }
      const roleArn = remoteTargets
        ? yield* runtime.get<string>(REMOTE_KEY_ENV.roleArn)
        : undefined;
      if (roleArn !== undefined) {
        return yield* withCreatedKey(operation, region, runtime, roleArn, REMOTE_KEY_ENV, true);
      }
    }
  }
  // A host running as an IAM role signs with its own credentials.
  if (globalThis.__ALCHEMY_HOST_IDENTITY__ === "AWS.IAM.Role")
    return yield* operation as Effect.Effect<Op>;
  // A host running as a Google service account assumes its Role with an ID
  // token; it never has a key, so the bundler drops that path.
  if (globalThis.__ALCHEMY_HOST_IDENTITY__ === "GCP.IAM.ServiceAccount") {
    return yield* withWebIdentity(operation, region);
  }
  if (!globalThis.__ALCHEMY_RUNTIME__) {
    const host = yield* Binding.Host;
    if (region !== undefined && host !== undefined && !runsAsRole(host)) {
      yield* region as Effect.Effect<Effect.Effect<string>>;
    }
    return yield* operation as Effect.Effect<Op>;
  }

  const runtime = yield* CurrentRuntimeContext;
  const roleArn = runtime ? yield* runtime.get<string>(KEY_ENV.roleArn) : undefined;
  if (runtime === undefined || roleArn === undefined) {
    return yield* operation as Effect.Effect<Op>;
  }
  return yield* withCreatedKey(operation, region, runtime, roleArn, KEY_ENV, false);
});

/**
 * Resolve an operation with a key Alchemy created for the host: the key
 * signs `AssumeRole` on the Role holding the binding's statements.
 *
 * @param realCloud sign against the real AWS endpoint even when the host's
 *   environment names an emulator (`AWS_ENDPOINT_URL`).
 */
const withCreatedKey = Effect.fn(function* <Op>(
  operation: Effect.Effect<Op, never, any>,
  region: Effect.Effect<Effect.Effect<string>, never, any> | undefined,
  runtime: NonNullable<Effect.Success<typeof CurrentRuntimeContext>>,
  roleArn: string,
  env: typeof KEY_ENV | typeof REMOTE_KEY_ENV,
  realCloud: boolean,
) {
  const endpoint = realCloud
    ? Layer.succeed(Endpoint.Endpoint, Effect.succeed(undefined))
    : Endpoint.fromEnv();
  // The created user's key signs `AssumeRole`; read on each refresh.
  const base = Layer.merge(
    Layer.succeed(
      Credentials,
      Effect.gen(function* () {
        const secret = yield* runtime.get<string | Redacted.Redacted<string>>(env.secretAccessKey);
        return {
          accessKeyId: Redacted.make((yield* runtime.get<string>(env.accessKeyId)) ?? ""),
          secretAccessKey: Redacted.isRedacted(secret) ? secret : Redacted.make(secret ?? ""),
          sessionToken: undefined,
          // STS is global; operations provide their own Region.
          region: "us-east-1",
        } satisfies ResolvedCredentials;
      }),
    ),
    endpoint,
  );
  const credentials = yield* makeAssumeRoleResolver({
    roleArn: Effect.succeed(roleArn),
    base,
    region: "us-east-1",
  });
  const callRegion =
    region !== undefined
      ? yield* region as Effect.Effect<Effect.Effect<string>>
      : Effect.map(runtime.get<string>(env.region), (value) => value ?? "us-east-1");
  const context = Layer.mergeAll(
    Layer.succeed(Credentials, credentials),
    Layer.succeed(Region, callRegion as Effect.Effect<RegionName>),
    endpoint,
    FetchHttpClient.layer,
  );
  const op = yield* (operation as Effect.Effect<Op>).pipe(Effect.provide(context));
  // A distilled operation prefers the CALLER's context over the one it was
  // yielded in, and an emulated host's ambient names the emulator — provide
  // the real cloud around every call too.
  return realCloud ? provideCalls(op, context) : op;
});

/** Provide `context` around every call of an operation (or a tuple/record of them). */
const provideCalls = <Op>(op: Op, context: Layer.Layer<any>): Op => {
  if (typeof op === "function") {
    return ((...args: unknown[]) => {
      const result = (op as (...args: unknown[]) => unknown)(...args);
      return Effect.isEffect(result) ? Effect.provide(result, context) : result;
    }) as Op;
  }
  if (typeof op === "object" && op !== null) {
    return (
      Array.isArray(op)
        ? op.map((value) => provideCalls(value, context))
        : Object.fromEntries(
            Object.entries(op).map(([key, value]) => [key, provideCalls(value, context)]),
          )
    ) as Op;
  }
  return op;
};
