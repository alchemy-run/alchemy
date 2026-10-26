import type { ResolvedCredentials } from "@distilled.cloud/aws/Credentials";
import * as Endpoint from "@distilled.cloud/aws/Endpoint";
import { Region, type RegionName } from "@distilled.cloud/aws/Region";
import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Binding from "alchemy/Binding";
import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import { isResourceOfType, type ResourceLike } from "alchemy/Resource";
import { CurrentRuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import type * as rolldown from "rolldown";
import { DEFAULT_LOCAL_ENDPOINT } from "./AuthProvider.ts";
import { Credentials, makeAssumeRoleResolver } from "./Credentials.ts";
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
 * - any other host (a Cloudflare Worker, Cloud Run, a GKE pod): Alchemy
 *   creates an IAM User and AccessKey that may assume a Role, puts the
 *   statements on the Role, and binds the key into the host's env;
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
        return yield* (host as unknown as BindTarget).bind(
          labelled("Allow", label),
          host,
          ...args,
        )(data);
      }

      // The user may assume any role that trusts it; the role's trust policy
      // restricts assumption to this user, which avoids a User↔Role ARN cycle.
      const id = host.LogicalId;
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

      const runtime = (yield* CurrentRuntimeContext)!;
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
  // A host running as an IAM role signs with its own credentials.
  if (globalThis.__ALCHEMY_HOST_IDENTITY__ === "AWS.IAM.Role")
    return yield* operation as Effect.Effect<Op>;
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

  // The created user's key signs `AssumeRole`; read on each refresh.
  const base = Layer.succeed(
    Credentials,
    Effect.gen(function* () {
      const secret = yield* runtime.get<string | Redacted.Redacted<string>>(
        KEY_ENV.secretAccessKey,
      );
      return {
        accessKeyId: Redacted.make((yield* runtime.get<string>(KEY_ENV.accessKeyId)) ?? ""),
        secretAccessKey: Redacted.isRedacted(secret) ? secret : Redacted.make(secret ?? ""),
        sessionToken: undefined,
        // STS is global; operations provide their own Region.
        region: "us-east-1",
      } satisfies ResolvedCredentials;
    }),
  );
  const credentials = yield* makeAssumeRoleResolver({
    roleArn: Effect.succeed(roleArn),
    base,
    region: "us-east-1",
  });
  const callRegion =
    region !== undefined
      ? yield* region as Effect.Effect<Effect.Effect<string>>
      : Effect.map(runtime.get<string>(KEY_ENV.region), (value) => value ?? "us-east-1");
  return yield* (operation as Effect.Effect<Op>).pipe(
    Effect.provide([
      Layer.succeed(Credentials, credentials),
      Layer.succeed(Region, callRegion as Effect.Effect<RegionName>),
      Endpoint.fromEnv(),
      FetchHttpClient.layer,
    ]),
  );
});
