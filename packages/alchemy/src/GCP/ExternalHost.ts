import { Credentials, fromServiceAccountKey } from "@distilled.cloud/gcp/Credentials";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Output from "../Output.ts";
import type { ResourceLike } from "../Resource.ts";
import { CurrentRuntimeContext } from "../RuntimeContext.ts";
import type { GcpHostBinding } from "./Host.ts";
import { ExternalHostAccount } from "./IAM/ExternalHostAccount.ts";
import type { NativeHost } from "./NativeHost.ts";

/**
 * How an external host (a Cloudflare Worker, an AWS Lambda, …) reaches GCP: a
 * minted service account that every GCP binding on the host grants its roles
 * to, and one of its keys, delivered through the host's env, to sign with.
 * Only `GCPBindings.ts` imports this module, behind the native-host check, so
 * bundles built for a GCP host drop it.
 */

/** The identity an external host uses to reach GCP. */
export interface ExternalGcpAccess {
  /** The service account each binding grants its roles to. */
  readonly account: ExternalHostAccount;
  /** Access tokens minted from the account's key, refreshed near expiry. */
  readonly credentials: Layer.Layer<Credentials>;
}

// One identity per host instance, shared by every binding on it.
const externalAccessByHost = new WeakMap<ResourceLike, ExternalGcpAccess>();

const toRedacted = (value: string | Redacted.Redacted<string>) =>
  Redacted.isRedacted(value) ? value : Redacted.make(value);

/**
 * The identity an external host uses to reach GCP: `${id}ServiceAccount` and
 * its key. Yielding the account's attributes registers them on the host at
 * deploy and reads them from its env at runtime, so the declarations run in
 * both phases.
 */
export const externalGcpAccess = Effect.fn(function* (host: ResourceLike) {
  const cached = externalAccessByHost.get(host);
  if (cached !== undefined) return cached;

  // Yielding a resource class gives a constructor whose providers are the
  // host stack's (the same way the Cloudflare `*Http` bindings mint tokens).
  const Account = yield* ExternalHostAccount;
  const account = yield* Account(`${host.LogicalId}ServiceAccount`, { hostType: host.Type });

  const email = yield* account.email;
  const project = yield* account.project;
  const privateKeyId = yield* account.privateKeyId;
  const privateKey = yield* account.privateKey;

  // Built on first use from the host env (at deploy the env is empty), then
  // shared: distilled's provider caches the token and refreshes it near
  // expiry.
  const resolve = yield* Effect.cached(
    Effect.gen(function* () {
      const layer = fromServiceAccountKey({
        clientEmail: yield* email,
        privateKey: toRedacted(yield* privateKey),
        privateKeyId: yield* privateKeyId,
        project: yield* project,
      });
      return Context.get(yield* Layer.build(layer).pipe(Effect.scoped), Credentials);
    }),
  );
  const credentials = Layer.succeed(
    Credentials,
    Effect.flatMap(resolve, (config) => config),
  );

  const access: ExternalGcpAccess = { account, credentials };
  externalAccessByHost.set(host, access);
  return access;
});

/** The services an external host's GCP calls run with. */
export const externalServices = (access: ExternalGcpAccess) =>
  Layer.mergeAll(access.credentials, FetchHttpClient.layer);

/**
 * An external host as GCP bindings see it: `bind` accepts the same
 * `{ env, iam }` contract as a native host, sending the IAM grants to the
 * host's minted service account and the env through its `RuntimeContext`.
 * The grant keeps the host's name (`Allow(<host>, …)`).
 */
export const externalHost = (host: ResourceLike, access: ExternalGcpAccess): NativeHost => {
  const account = access.account as unknown as {
    bind: (...args: any[]) => (data: GcpHostBinding) => Effect.Effect<void>;
  };
  const bind =
    (...args: any[]) =>
    (data: GcpHostBinding) =>
      Effect.gen(function* () {
        if (data.cloudSqlInstances !== undefined && data.cloudSqlInstances.length > 0) {
          return yield* Effect.die(
            new Error(
              `Cloud SQL socket mounts are only available on Cloud Run, not on ${host.Type} ${host.LogicalId}.`,
            ),
          );
        }
        if (data.iam !== undefined && data.iam.length > 0) {
          yield* account.bind(...args)({ iam: data.iam });
        }
        const runtime = yield* CurrentRuntimeContext;
        for (const [key, value] of Object.entries(data.env ?? {})) {
          yield* runtime!.set(key, Output.isOutput(value) ? value : Output.literal(value));
        }
      });
  return {
    Type: host.Type,
    LogicalId: host.LogicalId,
    FQN: host.FQN,
    bind,
  } as unknown as NativeHost;
};
