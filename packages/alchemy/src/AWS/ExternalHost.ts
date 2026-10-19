import type {
  AwsCredentialProviderError,
  ResolvedCredentials,
} from "@distilled.cloud/aws/Credentials";
import * as Endpoint from "@distilled.cloud/aws/Endpoint";
import { Region, type RegionName } from "@distilled.cloud/aws/Region";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { AlchemyContext } from "../AlchemyContext.ts";
import * as Output from "../Output.ts";
import type { ResourceLike } from "../Resource.ts";
import { CurrentRuntimeContext } from "../RuntimeContext.ts";
import { DEFAULT_LOCAL_ENDPOINT } from "./AuthProvider.ts";
import { Credentials, makeAssumeRoleResolver } from "./Credentials.ts";
import { AccessKey } from "./IAM/AccessKey.ts";
import { Role } from "./IAM/Role.ts";
import { User } from "./IAM/User.ts";
import type { NativeHost } from "./NativeHost.ts";
import { CurrentRegion } from "./Region.ts";

/**
 * How an external host (a Cloudflare Worker, Cloud Run, …) reaches AWS: an
 * IAM User + AccessKey allowed to assume a least-privilege Role, which every
 * AWS binding on the host grants its statements to. Only `AWSBindings.ts`
 * imports this module, behind the native-host check, so bundles built for an
 * AWS host drop it.
 */

/** The IAM identity an external host uses to reach AWS. */
export interface ExternalAwsAccess {
  /** The least-privilege Role each binding grants its statements to. */
  readonly role: Role;
  /** Assumed-role credentials, cached and refreshed near expiry. */
  readonly credentials: Effect.Effect<ResolvedCredentials, AwsCredentialProviderError>;
  /** The stack's region, carried to the host through its env. */
  readonly region: Effect.Effect<string>;
}

// One identity per host instance, shared by every binding on it.
const externalAccessByHost = new WeakMap<ResourceLike, ExternalAwsAccess>();

/**
 * The IAM identity an external host uses to reach AWS: `${id}User` holding
 * `${id}AccessKey`, allowed to assume `${id}Role`. Yielding the key and role
 * attributes registers them on the host at deploy and reads them from its env
 * at runtime, so the declarations run in both phases.
 */
export const externalAwsAccess = Effect.fn(function* (host: ResourceLike) {
  const cached = externalAccessByHost.get(host);
  if (cached !== undefined) return cached;

  const id = host.LogicalId;
  // The user may assume any role that trusts it; the role's trust policy is
  // what restricts assumption to this user, which avoids a User↔Role ARN
  // dependency cycle.
  const user = yield* User(`${id}User`, {
    inlinePolicies: {
      AssumeRole: {
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Action: ["sts:AssumeRole"], Resource: ["*"] }],
      },
    },
  });
  const accessKey = yield* AccessKey(`${id}AccessKey`, {
    userName: user.userName,
  });
  const role = yield* Role(`${id}Role`, {
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

  // Local dev: STS and the bound operations run on the emulator, reached via
  // the same `AWS_ENDPOINT_URL` the emulator injects into Lambda containers
  // (read at runtime by `Endpoint.fromEnv()`).
  if (!globalThis.__ALCHEMY_RUNTIME__) {
    const context = yield* Effect.serviceOption(AlchemyContext);
    const runtime = yield* CurrentRuntimeContext;
    if (Option.isSome(context) && context.value.dev && runtime) {
      yield* runtime.set("AWS_ENDPOINT_URL", Output.literal(DEFAULT_LOCAL_ENDPOINT));
    }
  }

  const accessKeyId = yield* accessKey.accessKeyId;
  const secretAccessKey = yield* accessKey.secretAccessKey;
  const roleArn = yield* role.roleArn;
  const region = yield* (
    Output.fromEffect(CurrentRegion.pipe(Effect.orDie)) as Output.Output<string>
  ).bind("ALCHEMY_AWS_REGION");

  // The long-lived user credentials that sign `AssumeRole`, read from the
  // host env on each refresh (not captured: at deploy the env is empty).
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
        // STS is global; operations provide their own Region.
        region: "us-east-1",
      } satisfies ResolvedCredentials;
    }),
  );
  const credentials = yield* makeAssumeRoleResolver({
    roleArn,
    base,
    region: "us-east-1",
  });
  const access: ExternalAwsAccess = { role, credentials, region };
  externalAccessByHost.set(host, access);
  return access;
});

/** The services an external host's AWS calls run with. */
export const externalServices = (access: ExternalAwsAccess, region: Effect.Effect<string>) =>
  Layer.mergeAll(
    Layer.succeed(Credentials, access.credentials),
    Layer.succeed(Region, region as Effect.Effect<RegionName>),
    Endpoint.fromEnv(),
    FetchHttpClient.layer,
  );

/**
 * An external host as AWS bindings see it: `bind` accepts the same
 * `{ env, policyStatements }` contract as a native host, sending the IAM
 * statements to the host's minted role and the env through its
 * `RuntimeContext`. The grant keeps the host's name (`Allow(<host>, …)`).
 */
export const externalHost = (host: ResourceLike, access: ExternalAwsAccess): NativeHost => {
  const route =
    (bindRole: (data: { policyStatements: unknown[] }) => Effect.Effect<void>) =>
    (data: { env?: Record<string, unknown>; policyStatements?: unknown[] }) =>
      Effect.gen(function* () {
        if (data.policyStatements !== undefined && data.policyStatements.length > 0) {
          yield* bindRole({ policyStatements: data.policyStatements });
        }
        const runtime = yield* CurrentRuntimeContext;
        for (const [key, value] of Object.entries(data.env ?? {})) {
          yield* runtime!.set(key, Output.isOutput(value) ? value : Output.literal(value));
        }
      });
  const role = access.role as unknown as { bind: (...args: any[]) => any };
  const bind = (...args: any[]) =>
    typeof args[0] === "string"
      ? route((data) => role.bind(args[0], data))(args[1])
      : route((data) => role.bind(...args)(data));
  return {
    Type: host.Type,
    LogicalId: host.LogicalId,
    FQN: host.FQN,
    bind,
  } as unknown as NativeHost;
};
