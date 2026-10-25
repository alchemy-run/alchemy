import { Credentials, fromClientSecret, fromManagedIdentity } from "@distilled.cloud/azure";
import * as Binding from "alchemy/Binding";
import type * as Bundle from "alchemy/Bundle/Bundle";
import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import { isResourceOfType, type ResourceLike } from "alchemy/Resource";
import { CurrentRuntimeContext } from "alchemy/RuntimeContext";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { RoleAssignment } from "./Authorization/RoleAssignment.ts";
import { Application } from "./Entra/Application.ts";
import { ApplicationPassword } from "./Entra/ApplicationPassword.ts";
import { ServicePrincipal } from "./Entra/ServicePrincipal.ts";

/**
 * How an Azure binding reaches Azure from its host:
 *
 * - the host runs as an Azure managed identity (Functions, App Service,
 *   Container Apps, Container Instances, VMs, an AKS pod with workload
 *   identity): the roles are assigned to that identity, and calls use its
 *   managed-identity tokens;
 * - any other host (a Cloudflare Worker, an AWS Lambda, a GKE pod): Alchemy
 *   creates an Entra application, service principal, and client secret for
 *   it, assigns the roles to that service principal, and binds the secret
 *   into the host's env;
 * - no host (a script or deploy-time Action): nothing is bound and calls use
 *   the deployer's credentials.
 *
 * Import it as a namespace. A binding resolves its operations with
 * {@link withCredentials} and gets its `bind` from {@link Bind} when its layer
 * is built, then binds behind its own `__ALCHEMY_RUNTIME__` guard:
 *
 * ```ts
 * Effect.gen(function* () {
 *   const enqueue = yield* AzureBindings.withCredentials(queue.MessagesEnqueue);
 *   const bind = yield* AzureBindings.Bind;
 *   return Effect.fn(function* (jobs: Storage.Queue) {
 *     if (!globalThis.__ALCHEMY_RUNTIME__) {
 *       yield* bind`Azure.Storage.QueueSend(${jobs})`({
 *         roleAssignments: [
 *           { roleDefinitionId: BuiltInRole.StorageQueueDataMessageSender, scope: jobs.queueId },
 *         ],
 *       });
 *     }
 *     return (text) => enqueue({ url: …, queueName: …, MessageText: text });
 *   });
 * })
 * ```
 */

/** One Azure RBAC role a binding needs, on the narrowest scope that works. */
export interface HostRoleAssignment {
  /**
   * A built-in role GUID (`Azure.Authorization.BuiltInRole.*`) or the ID of
   * an `Azure.Authorization.RoleDefinition` the binding creates when the
   * built-in role is broader than its data actions.
   */
  readonly roleDefinitionId: string;
  /** ARM ID the role is assigned on: the bound resource, never wider. */
  readonly scope: string;
}

/** What an Azure binding attaches to its host. */
export interface HostBinding {
  /** The RBAC roles the binding needs. */
  readonly roleAssignments?: Input<HostRoleAssignment>[];
  /** Env vars the binding reads at runtime. */
  readonly env?: Record<string, unknown>;
}

/** Value of `__ALCHEMY_HOST_IDENTITY__` in a bundle that runs as a managed identity. */
export const MANAGED_IDENTITY = "Azure.ManagedIdentity";

/** Rolldown input options, as `Bundle.build` takes them (azure has no direct rolldown dependency). */
type BundleInputOptions = Parameters<typeof Bundle.build>[0];

/**
 * Build options for a bundle that runs on a host with an Azure managed
 * identity (Functions, App Service, Container Apps, Container Instances,
 * VMs, AKS workload identity): defines `__ALCHEMY_HOST_IDENTITY__` as
 * `"Azure.ManagedIdentity"` so the bundler drops the created-secret
 * credentials path. Every Azure host bundler applies it.
 */
export const managedIdentityHostBundle = (input: BundleInputOptions): BundleInputOptions => ({
  ...input,
  transform: {
    ...input.transform,
    define: {
      ...input.transform?.define,
      "globalThis.__ALCHEMY_HOST_IDENTITY__": JSON.stringify(MANAGED_IDENTITY),
    },
  },
});

/**
 * Env vars holding the client secret Alchemy creates for a host that has no
 * managed identity. Only {@link Bind} sets them, and only on that path, so
 * at runtime their presence is the whole decision.
 */
export const IDENTITY_ENV = {
  tenantId: "ALCHEMY_AZURE_TENANT_ID",
  clientId: "ALCHEMY_AZURE_CLIENT_ID",
  clientSecret: "ALCHEMY_AZURE_CLIENT_SECRET",
} as const;

/**
 * Whether a host runs its code as an Azure managed identity: an Azure
 * Function, a Function App, a Web App, a Container App or Container Apps
 * job, a container group, a VM, or a Kubernetes workload on an AKS cluster
 * with workload identity. Deploy-time only: it reads the host's props.
 */
export const runsAsManagedIdentity = (host: ResourceLike): boolean => {
  switch (host.Type) {
    case "Azure.Functions.Function":
    case "Azure.Web.FunctionApp":
    case "Azure.Web.WebApp":
    case "Azure.ContainerApps.ContainerApp":
    case "Azure.ContainerApps.Job":
    case "Azure.ContainerInstance.ContainerGroup":
    case "Azure.Compute.VirtualMachine":
      return true;
    case "Kubernetes.Deployment":
    case "Kubernetes.Job":
      return isWorkloadIdentityCluster(host.Props?.cluster);
    default:
      return false;
  }
};

/** An `Azure.ContainerService.ManagedCluster` with workload identity enabled. */
const isWorkloadIdentityCluster = (cluster: unknown): boolean =>
  isResourceOfType(cluster, "Azure.ContainerService.ManagedCluster") &&
  (cluster as { Props?: { workloadIdentityEnabled?: unknown } }).Props?.workloadIdentityEnabled ===
    true;

/** Label a grant `Allow(<host>, <label>)`, as `host.bind` records it. */
const allow = (label: TemplateStringsArray): TemplateStringsArray => {
  const strings = ["Allow(", `, ${label[0]}`, ...label.slice(1)];
  strings[strings.length - 1] += ")";
  // A template-strings array is a frozen string array with `raw`; TS has no
  // constructor for one.
  return Object.assign(strings, { raw: strings }) as unknown as TemplateStringsArray;
};

/** A binding label with its arguments filled in, e.g. `Azure.Storage.QueueSend(Jobs)`. */
const renderLabel = (label: TemplateStringsArray, args: readonly unknown[]) =>
  label
    .flatMap((part, i) => {
      if (i >= args.length) return [part];
      const arg = args[i];
      const logicalId = (arg as { LogicalId?: unknown } | undefined)?.LogicalId;
      return [
        part,
        typeof arg === "string" ? arg : typeof logicalId === "string" ? logicalId : String(i),
      ];
    })
    .join("");

type BindTarget = {
  bind: (...args: unknown[]) => (data: unknown) => Effect.Effect<void>;
};

const toOutput = (value: unknown) => (Output.isOutput(value) ? value : Output.literal(value));

/** The signature {@link Bind} yields. */
export type BindHost = (
  label: TemplateStringsArray,
  ...args: unknown[]
) => (data: HostBinding) => Effect.Effect<void>;

/**
 * The `bind` for a binding's layer: yield it while the layer is built, then
 * call it from the returned function, behind a literal
 * `if (!globalThis.__ALCHEMY_RUNTIME__)` so the bundler drops it. It attaches
 * the binding to its host labelled `Allow(<host>, <label>)`:
 *
 * - a host that runs as a managed identity gets the data through its own
 *   `bind`: its provider assigns `roleAssignments` to the identity and sets
 *   `env`;
 * - any other host gets an Entra application `<host>AzureIdentity`, its
 *   service principal and a client secret; each role is assigned to that
 *   service principal with an `Azure.Authorization.RoleAssignment`, and
 *   `ALCHEMY_AZURE_TENANT_ID`, `ALCHEMY_AZURE_CLIENT_ID`,
 *   `ALCHEMY_AZURE_CLIENT_SECRET` (Redacted) and `env` are bound into the
 *   host's env.
 *
 * ```ts
 * Effect.gen(function* () {
 *   const bind = yield* AzureBindings.Bind;
 *   return Effect.fn(function* (container: Storage.BlobContainer) {
 *     if (!globalThis.__ALCHEMY_RUNTIME__) {
 *       yield* bind`Azure.Storage.BlobContainerRead(${container})`({ roleAssignments: [ … ] });
 *     }
 *   });
 * })
 * ```
 */
export const Bind: Effect.Effect<BindHost> = Effect.gen(function* () {
  // Bindings only bind at deploy, so a host bundle captures nothing here
  // and drops the identity resources.
  if (globalThis.__ALCHEMY_RUNTIME__) return () => () => Effect.void;
  const EntraApplication = yield* Application;
  const EntraServicePrincipal = yield* ServicePrincipal;
  const EntraApplicationPassword = yield* ApplicationPassword;
  const AzureRoleAssignment = yield* RoleAssignment;

  return (label: TemplateStringsArray, ...args: unknown[]) =>
    Effect.fn(function* (data: HostBinding) {
      const host = yield* Binding.Host;
      if (host === undefined) return;

      if (runsAsManagedIdentity(host)) {
        return yield* (host as unknown as BindTarget).bind(allow(label), host, ...args)(data);
      }

      const id = `${host.LogicalId}AzureIdentity`;
      const app = yield* EntraApplication(id, {
        displayName: `Alchemy: Azure access for ${host.LogicalId}`.slice(0, 120),
        notes: `Created by Alchemy for ${host.Type} ${host.LogicalId} to call Azure.`,
      });
      const principal = yield* EntraServicePrincipal(`${id}Principal`, { appId: app.appId });
      const secret = yield* EntraApplicationPassword(`${id}Secret`, {
        applicationObjectId: app.objectId,
        displayName: "alchemy",
      });
      const grants = data.roleAssignments ?? [];
      const rendered = renderLabel(label, args);
      const grantId = rendered.replace(/[^A-Za-z0-9]+/g, "");
      for (const [index, grant] of grants.entries()) {
        const { roleDefinitionId, scope } = grant as HostRoleAssignment;
        yield* AzureRoleAssignment(`${id}${grantId}${grants.length > 1 ? index : ""}`, {
          scope,
          roleDefinitionId,
          principalId: principal.objectId,
          // Skips the directory lookup that fails while the new service
          // principal replicates.
          principalType: "ServicePrincipal",
          description: `${host.LogicalId}: ${rendered}`.slice(0, 200),
        });
      }
      const runtime = (yield* CurrentRuntimeContext)!;
      yield* runtime.set(IDENTITY_ENV.tenantId, app.tenantId);
      yield* runtime.set(IDENTITY_ENV.clientId, app.appId);
      yield* runtime.set(IDENTITY_ENV.clientSecret, secret.secretText);
      for (const [name, value] of Object.entries(data.env ?? {})) {
        yield* runtime.set(name, toOutput(value));
      }
    });
});

/** The `Credentials` service value a credentials layer holds. */
const credentialsOf = (layer: Layer.Layer<Credentials>) =>
  Layer.build(layer).pipe(
    Effect.scoped,
    Effect.map((context) => Context.get(context, Credentials)),
  );

/**
 * Resolve a distilled operation with the host's Azure credentials, once when the binding's layer is built:
 *
 * - in a bundle built with {@link managedIdentityHostBundle}: the host's
 *   managed identity (`fromManagedIdentity`);
 * - on a host {@link Bind} created a client secret for: that secret
 *   (`fromClientSecret`), read back from the runtime env;
 * - otherwise as-is (the deployer's credentials).
 *
 * Each operation asks for its own token audience (`tokenFor(scope)`).
 */
export const withCredentials: <Op>(operation: Effect.Effect<Op, never, any>) => Effect.Effect<Op> =
  Effect.fn(function* <Op>(operation: Effect.Effect<Op, never, any>) {
    if (globalThis.__ALCHEMY_HOST_IDENTITY__ === MANAGED_IDENTITY) {
      const credentials = yield* credentialsOf(fromManagedIdentity());
      return yield* (operation as Effect.Effect<Op>).pipe(
        Effect.provide(
          Layer.mergeAll(Layer.succeed(Credentials, credentials), FetchHttpClient.layer),
        ),
      );
    }
    const runtime = yield* CurrentRuntimeContext;
    const clientId =
      globalThis.__ALCHEMY_RUNTIME__ && runtime !== undefined
        ? yield* runtime.get<string>(IDENTITY_ENV.clientId)
        : undefined;
    if (runtime === undefined || clientId === undefined) {
      return yield* operation as Effect.Effect<Op>;
    }
    const tenantId = yield* runtime.get<string>(IDENTITY_ENV.tenantId);
    const secret = yield* runtime.get<string | Redacted.Redacted<string>>(
      IDENTITY_ENV.clientSecret,
    );
    const credentials = yield* credentialsOf(
      fromClientSecret({
        tenantId: tenantId ?? "",
        clientId,
        clientSecret: Redacted.isRedacted(secret) ? secret : Redacted.make(secret ?? ""),
        // Data-plane operations take no subscription.
        subscriptionId: "",
      }),
    );
    return yield* (operation as Effect.Effect<Op>).pipe(
      Effect.provide(
        Layer.mergeAll(Layer.succeed(Credentials, credentials), FetchHttpClient.layer),
      ),
    );
  });

/**
 * Turn a logical ID into an env-var-safe suffix, e.g. `my-files` →
 * `MY_FILES`.
 */
export const envSuffix = (logicalId: string) =>
  logicalId.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase();
