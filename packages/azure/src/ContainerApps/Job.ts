import type { Credentials } from "@distilled.cloud/azure";
import * as app from "@distilled.cloud/azure/app";
import * as containerregistry from "@distilled.cloud/azure/containerregistry";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Bundle from "alchemy/Bundle/Bundle";
import { findCwdForBundle, resolveMainPath } from "alchemy/Bundle/TempRoot";
import { isResolved } from "alchemy/Diff";
import type { InputProps } from "alchemy/Input";
import * as Namespace from "alchemy/Namespace";
import { Platform, type Main, type PlatformProps, type PlatformServices } from "alchemy/Platform";
import * as Provider from "alchemy/Provider";
import type { Resource, ResourceBinding } from "alchemy/Resource";
import {
  createContainerRuntimeContext,
  type HostRuntimeContext,
  type ServerHost,
} from "alchemy/Runtime/Process";
import { packEnvValue, type RuntimeContext } from "alchemy/RuntimeContext";
import { Stack } from "alchemy/Stack";
import { sha256Object } from "alchemy/Util/sha256";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import type { Scope } from "effect/Scope";
import {
  collectAll,
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { managedIdentityHostBundle } from "../AzureBindings.ts";
import { Registry } from "../ContainerRegistry/Registry.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { stackResourceGroup } from "../StackResourceGroup.ts";
import {
  createContainerAppsName,
  fingerprint,
  identityMatches,
  lower,
  matchesDesired,
  sameLocation,
  secretsMatch,
  toIdentity,
  toSecrets,
  type ContainerAppsIdentity,
  type ContainerAppsSecret,
} from "./common.ts";
import { syncBindingAssignments } from "./ContainerApp.ts";
import { DEFAULT_BASE_IMAGE, pushProgramImage } from "./internal/image.ts";

export type { InferEnv } from "../InferEnv.ts";

export const JobTypeId = "Azure.ContainerApps.Job" as const;
export type JobTypeId = typeof JobTypeId;

/**
 * Job configuration: trigger type (`Manual`, `Schedule`, `Event`) and its
 * trigger config, replica timeout and retries, registries. Secrets are set
 * with the separate `secrets` prop.
 */
export type JobConfiguration = Omit<app.JobConfiguration, "secrets">;

/** Job template: containers, init containers, volumes. */
export type JobTemplate = app.JobTemplateInput;

/** A role the job's managed identity holds on one scope. */
export interface JobRoleAssignment {
  /** Built-in role GUID or full role-definition ARM ID. */
  roleDefinitionId: string;
  /** ARM ID the role is granted on: the bound resource, never wider. */
  scope: string;
}

/** A KEDA scale rule that starts executions of an event-driven job. */
export interface JobScaleRule {
  /** Rule name, unique in the job (lowercase letters, digits, `-`). */
  name: string;
  /** KEDA scaler type, e.g. `azure-queue`, `azure-servicebus`. */
  type: string;
  /** Scaler metadata, e.g. `{ queueName, queueLength, accountName }`. */
  metadata: Record<string, string>;
  /** Managed identity the scaler authenticates with (`system` or an ARM ID). */
  identity?: string;
}

/**
 * Binding contract accepted by `Azure.ContainerApps.Job` (the Azure
 * `HostBinding` shape plus the job's trigger):
 *
 * - `roleAssignments` are granted to the job's system-assigned identity;
 *   the ones a deploy no longer asks for are revoked (only ones it made).
 * - `env` becomes container environment variables.
 * - `scaleRules` make the job event-driven (`triggerType: "Event"`).
 * - `schedule` makes the job run on a cron schedule.
 */
export interface JobBinding {
  roleAssignments?: JobRoleAssignment[];
  env?: Record<string, unknown>;
  scaleRules?: JobScaleRule[];
  schedule?: string;
}

/** An existing container registry the job's image is pushed to. */
export interface JobRegistryRef {
  /** Name of the registry (`Azure.ContainerRegistry.Registry`'s `registryName`). */
  registryName: string;
  /** Resource group of the registry. */
  resourceGroup: string;
}

/**
 * The registry Alchemy pushes the program's image to. Set automatically.
 * @internal
 */
export interface JobHosting {
  registryName: string;
  registryResourceGroup: string;
  repository: string;
}

export interface JobProps<
  Env extends Record<string, any> = Record<string, any>,
> extends PlatformProps {
  /**
   * Resource group the job is created in. Changing it replaces the job.
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup?: string;
  /**
   * Job name: 2-32 lowercase letters, digits, and hyphens, starting with a
   * letter. If omitted, a unique name is generated from the app, stage, and
   * logical ID. Changing it replaces the job.
   */
  name?: string;
  /**
   * Azure location; must match the environment's location. Changing it
   * replaces the job.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * ARM ID of the Container Apps environment (`environment.environmentId`).
   * Jobs need a standard (not `Express`) environment. Changing it replaces
   * the job.
   */
  environmentId: string;
  /**
   * Workload profile of the environment to run on.
   * @default the environment's Consumption profile
   */
  workloadProfileName?: string;
  /**
   * Trigger, timeout, retry, and registry configuration. Event sources and
   * `Azure.ContainerApps.schedule` set the trigger for you.
   * @default a `Manual` job: 1 replica per execution, 30 minute timeout, no retries
   */
  configuration?: JobConfiguration;
  /**
   * Containers each execution runs. Required without `main`. With `main`,
   * the first container runs the program (its `image` is replaced); the
   * other containers and `volumes` are kept.
   */
  template?: JobTemplate;
  /** Secrets referenced by env vars, registries, and scale rules. */
  secrets?: ContainerAppsSecret[];
  /**
   * Managed identity of the job. A job with `main` or bindings always has a
   * system-assigned identity.
   */
  identity?: ContainerAppsIdentity;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
  /**
   * Entry module of a program Alchemy bundles and runs. For an Effect job
   * this is `import.meta.url` (the file is both the bundle entry and the
   * program). For an async job it is a handler file that default-exports
   * `{ run(env) }`. Alchemy bundles it for Node.js into one ESM file and
   * builds an image on `baseImage` in a container registry, without Docker.
   */
  main?: string;
  /**
   * Named export of `main` that holds the program or handler.
   * @default "default"
   */
  handler?: string;
  /** Rolldown overrides for the bundle. */
  build?: Bundle.BundleConfig;
  /**
   * Environment variables of the job's containers. Accepts literals,
   * `Config` values, Outputs, and resources (a resource arrives as its
   * attributes, JSON-encoded). `Redacted` values are stored as job secrets
   * and referenced with `secretRef`.
   *
   * On an async job, {@link InferEnv} types the handler's `env` argument
   * from this object.
   */
  env?: Env;
  /**
   * vCPUs of the program's container. On the Consumption profile, pair it
   * with `memory` at 2 GiB per vCPU (0.25/0.5Gi up to 4/8Gi).
   * @default 0.5
   */
  cpu?: number;
  /**
   * Memory of the program's container, e.g. `"1Gi"`.
   * @default "1Gi"
   */
  memory?: string;
  /**
   * Public image the program runs on (`[registry/]repository[:tag]`). It
   * needs `node` on the `PATH`; the image is imported into the registry.
   * @default "mcr.microsoft.com/azurelinux/base/nodejs:24"
   */
  baseImage?: string;
  /**
   * Push the program's image to an existing registry instead of creating
   * a Basic registry for the job. The deployer needs push access, and the
   * job's identity is granted **AcrPull** on it.
   */
  registry?: JobRegistryRef;
  /** @internal Set automatically by Alchemy. */
  hosting?: JobHosting;
}

export interface JobAttributes {
  /** Name of the job. */
  jobName: string;
  /** ARM resource ID of the job; use it as a role-assignment scope. */
  jobId: string;
  /** Resource group that holds the job. */
  resourceGroup: string;
  /** Location of the job. */
  location: string;
  /** ARM ID of the environment the job runs in. */
  environmentId: string;
  /** Trigger type of the job (`Manual`, `Schedule`, `Event`). */
  triggerType: string;
  /** Outbound IP addresses of the job. */
  outboundIpAddresses: string[];
  /** Event stream endpoint of the job. */
  eventStreamEndpoint: string | undefined;
  /** Principal ID of the system-assigned identity, if enabled. */
  principalId: string | undefined;
  /** User tags (Alchemy ownership tags stripped). */
  tags: Record<string, string>;
  /** Image of the program's container (jobs with `main`). */
  image: string | undefined;
  /** Hash of the bundled program (jobs with `main`). */
  codeHash: string | undefined;
  /** Hash of the last applied job body. */
  configHash: string | undefined;
}

export interface Job<Env extends Record<string, any> = Record<string, any>> extends Resource<
  JobTypeId,
  JobProps<Env>,
  JobAttributes,
  JobBinding,
  Providers
> {}

export type JobServices = Credentials | ServerHost;
export type JobRuntimeContext = HostRuntimeContext;

/**
 * Effect job shape: a `run` effect that executes once per execution. The
 * container exits when `run` and every event source's runner finish.
 */
export type JobShape =
  | void
  | (Exclude<Main<JobServices>, void> & {
      run?: Effect.Effect<void, never, JobServices | PlatformServices | RuntimeContext | Scope>;
    });

const transformJobProps = (id: string, props: JobProps) =>
  Effect.gen(function* () {
    // Composition is a deploy concern; inside the bundle props are final.
    if (globalThis.__ALCHEMY_RUNTIME__) return props;
    const resourceGroup = props.resourceGroup ?? (yield* stackResourceGroup).name;
    if (props.main === undefined) return { ...props, resourceGroup };
    const repository = `alchemy/${id.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`.replace(/-+$/, "");
    if (props.registry !== undefined) {
      return {
        ...props,
        resourceGroup,
        hosting: {
          registryName: props.registry.registryName,
          registryResourceGroup: props.registry.resourceGroup,
          repository,
        },
      };
    }
    const registry = yield* Registry("Registry", {
      resourceGroup,
      location: props.location,
      sku: "Basic",
    }).pipe(Namespace.push(id));
    return {
      ...props,
      resourceGroup,
      hosting: {
        registryName: registry.registryName,
        registryResourceGroup: registry.resourceGroup,
        repository,
      },
    };
  });

/**
 * An Azure Container Apps job (`Microsoft.App/jobs`): containers that run
 * to completion on demand (`Manual`), on a cron schedule (`Schedule`), or
 * when a KEDA scaler sees events (`Event`).
 *
 * A job runs either the containers you list in `template`, or a program
 * Alchemy bundles from `main`. For a program, Alchemy bundles `main` for
 * Node.js and builds an image on a public Node.js base image in an Azure
 * Container Registry (a Basic registry it creates, or `registry`), without
 * Docker. The job gets a system-assigned identity with **AcrPull** on the
 * registry and pulls the image with it.
 *
 * Jobs need a standard `ManagedEnvironment` (not `Express`).
 *
 * :::caution[Changing `name`, `resourceGroup`, `location`, or `environmentId` replaces the job]
 * A new job is created and the old one is deleted.
 * :::
 *
 * @see https://learn.microsoft.com/azure/container-apps/jobs
 *
 * ### Effect Jobs
 * A job is a class. Props describe the job, and the Effect is the program.
 * `main: import.meta.url` makes the file both the bundle entry and the
 * program. Init binds resources; `run` executes once per execution, and the
 * container exits when it finishes.
 *
 * **Example:** Effect job that writes a report blob
 * ```typescript
 * // src/report.ts
 * import * as Azure from "@alchemy.run/azure";
 * import * as Effect from "effect/Effect";
 * import { Env, Reports } from "./resources.ts";
 *
 * export default class Report extends Azure.ContainerApps.Job<Report>()(
 *   "Report",
 *   Effect.gen(function* () {
 *     const env = yield* Env;
 *     return { main: import.meta.url, environmentId: env.environmentId };
 *   }),
 *   Effect.gen(function* () {
 *     const container = yield* Reports;
 *     const reports = yield* Azure.Storage.BlobContainerReadWrite(container);
 *     return {
 *       run: reports.put("report.txt", "done").pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.BlobContainerReadWriteHttp)),
 * ) {}
 * ```
 *
 * **Example:** Deploying it from the stack
 * ```typescript
 * // alchemy.run.ts
 * import Report from "./src/report.ts";
 *
 * export default Alchemy.Stack(
 *   "Reports",
 *   { providers: Azure.providers(), state: Alchemy.localState() },
 *   Effect.gen(function* () {
 *     const job = yield* Report;
 *     return { job: job.jobName, resourceGroup: job.resourceGroup };
 *   }),
 * );
 * ```
 *
 * ### Async Jobs
 * You don't have to use Effect. Call the job with `main` pointing at a
 * plain handler file and no implementation. Alchemy bundles that file as-is
 * (no Effect runtime in it). The `env` prop takes literals, `Config` values,
 * and resources, and {@link InferEnv} types the handler's `env` argument.
 * The execution succeeds when `run` resolves and fails when it throws.
 *
 * **Example:** Declaring an async job
 * ```typescript
 * // alchemy.run.ts
 * export const Cleanup = Azure.ContainerApps.Job("Cleanup", {
 *   main: "./src/cleanup.ts",
 *   environmentId: env.environmentId,
 *   env: {
 *     MAX_AGE_DAYS: "30",
 *     API_KEY: Config.redacted("API_KEY"),
 *     UPLOADS: uploads,
 *   },
 * });
 * export type CleanupEnv = Azure.InferEnv<typeof Cleanup>;
 * ```
 *
 * **Example:** Writing the async handler
 * ```typescript
 * // src/cleanup.ts
 * import type { CleanupEnv } from "../alchemy.run.ts";
 *
 * export default {
 *   async run(env: CleanupEnv) {
 *     console.log(`cleaning ${env.UPLOADS.containerName} (> ${env.MAX_AGE_DAYS} days)`);
 *   },
 * };
 * ```
 *
 * ### Container Jobs
 * **Example:** Manually triggered job from a public image
 * ```typescript
 * const job = yield* Azure.ContainerApps.Job("migrate", {
 *   environmentId: env.environmentId,
 *   configuration: {
 *     triggerType: "Manual",
 *     replicaTimeout: 300,
 *     manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 },
 *   },
 *   template: {
 *     containers: [
 *       {
 *         name: "migrate",
 *         image: "mcr.microsoft.com/k8se/quickstart-jobs:latest",
 *         resources: { cpu: 0.25, memory: "0.5Gi" },
 *       },
 *     ],
 *   },
 * });
 * ```
 *
 * **Example:** Scheduled container job
 * ```typescript
 * const nightly = yield* Azure.ContainerApps.Job("nightly", {
 *   environmentId: env.environmentId,
 *   configuration: {
 *     triggerType: "Schedule",
 *     replicaTimeout: 1800,
 *     scheduleTriggerConfig: { cronExpression: "0 2 * * *" },
 *   },
 *   template: { containers: [{ name: "report", image }] },
 * });
 * ```
 *
 * ### Configuration
 * **Example:** Size, timeout, and retries
 * ```typescript
 * export default class Import extends Azure.ContainerApps.Job<Import>()(
 *   "Import",
 *   {
 *     main: import.meta.url,
 *     environmentId,
 *     cpu: 1,
 *     memory: "2Gi",
 *     configuration: {
 *       triggerType: "Manual",
 *       replicaTimeout: 3600,
 *       replicaRetryLimit: 2,
 *     },
 *     tags: { team: "data" },
 *   },
 *   program,
 * ) {}
 * ```
 *
 * **Example:** Push to a shared registry and pick the base image
 * ```typescript
 * const registry = yield* Azure.ContainerRegistry.Registry("Shared");
 * const job = yield* Azure.ContainerApps.Job("Nightly", {
 *   main: "./src/nightly.ts",
 *   environmentId: env.environmentId,
 *   registry: { registryName: registry.registryName, resourceGroup: registry.resourceGroup },
 *   baseImage: "docker.io/library/node:24-slim",
 * });
 * ```
 *
 * ### Scheduling
 * `Azure.ContainerApps.schedule` makes the job run on a cron schedule (five
 * fields, UTC) and runs its handler in each execution.
 *
 * **Example:** Run every night at 02:00 UTC
 * ```typescript
 * export default class Nightly extends Azure.ContainerApps.Job<Nightly>()(
 *   "Nightly",
 *   { main: import.meta.url, environmentId },
 *   Effect.gen(function* () {
 *     yield* Azure.ContainerApps.schedule("0 2 * * *", Effect.log("nightly run"));
 *   }),
 * ) {}
 * ```
 *
 * ### Bindings
 * Bindings grant the job's managed identity the smallest data role on the
 * bound resource and hand the program a typed client.
 *
 * **Example:** Read a Key Vault secret
 * ```typescript
 * Effect.gen(function* () {
 *   const apiKey = yield* Azure.KeyVault.SecretRead(secret);
 *   return {
 *     run: Effect.gen(function* () {
 *       const key = yield* apiKey.get();
 *       yield* Effect.log(`key has ${Redacted.value(key).length} characters`);
 *     }).pipe(Effect.orDie),
 *   };
 * }).pipe(Effect.provide(Azure.KeyVault.SecretReadHttp))
 * ```
 *
 * **Example:** Send to a Storage queue
 * ```typescript
 * // init
 * const send = yield* Azure.Storage.QueueSend(jobs);
 *
 * // run
 * yield* send.send(JSON.stringify({ id: 1 }));
 * ```
 *
 * ### Event Sources
 * An event source adds a KEDA scale rule (the job becomes `Event`
 * triggered), grants the roles the scaler and the program need, and runs
 * the handler for the pending messages in each execution. The contract
 * lives in the source's service; provide the job's layer.
 *
 * **Example:** Process a Storage queue
 * ```typescript
 * yield* Azure.Storage.consumeQueueMessages(jobs, (message) =>
 *   Effect.log(message.body),
 * );
 * // …provided with Effect.provide(Azure.ContainerApps.JobStorageQueueEventSource)
 * ```
 *
 * **Example:** Process a Service Bus queue
 * ```typescript
 * yield* Azure.ServiceBus.consumeQueueMessages(orders, (message) =>
 *   Effect.log(message.body),
 * );
 * // …provided with Effect.provide(Azure.ContainerApps.JobServiceBusQueueEventSource)
 * ```
 *
 * @resource
 * @category ContainerApps
 */
export const Job: Platform<Job, JobServices, JobShape, JobRuntimeContext, {}, JobProps> & {
  /**
   * Async (no-impl) constructor: captures the `env` literal so
   * {@link InferEnv} types the handler's `env` argument.
   */
  <const Env extends Record<string, any>, PropsReq = never>(
    id: string,
    props: InputProps<JobProps<Env>> | Effect.Effect<InputProps<JobProps<Env>>, never, PropsReq>,
  ): Effect.Effect<Job<Env>, never, Providers | PropsReq>;
} = Platform(JobTypeId, {
  createRuntimeContext: createContainerRuntimeContext(JobTypeId),
  transformProps: (id, props) => transformJobProps(id, props),
});

export class JobImageMissing extends Data.TaggedError("Azure.ContainerApps.JobImageMissing")<{
  message: string;
}> {}

export class JobResourceGroupMissing extends Data.TaggedError(
  "Azure.ContainerApps.JobResourceGroupMissing",
)<{ message: string }> {}

export class JobTriggerConflict extends Data.TaggedError("Azure.ContainerApps.JobTriggerConflict")<{
  jobName: string;
  message: string;
}> {}

export class JobRegistryNotFound extends Data.TaggedError(
  "Azure.ContainerApps.JobRegistryNotFound",
)<{ registryName: string; message: string }> {}

/** AcrPull: pull images from the job's registry. */
const ACR_PULL = "7f951dda-4ed3-4680-a7ca-43fe172d538d";

/** Public image the job runs while its identity is granted AcrPull. */
const PLACEHOLDER_IMAGE = "mcr.microsoft.com/k8se/quickstart-jobs:latest";

const createJobName = (id: string) => createContainerAppsName(id, 32);

const getJob = (subscriptionId: string, resourceGroupName: string, jobName: string) =>
  orUndefinedIfNotFound(app.GetJob({ subscriptionId, resourceGroupName, jobName }));

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: app.GetJobResponse,
  extras: Pick<JobAttributes, "image" | "codeHash" | "configHash">,
): JobAttributes => ({
  jobName: name,
  jobId: observed.id ?? "",
  resourceGroup,
  location: observed.location,
  environmentId: observed.properties?.environmentId ?? "",
  triggerType: observed.properties?.configuration?.triggerType ?? "",
  outboundIpAddresses: [...(observed.properties?.outboundIpAddresses ?? [])],
  eventStreamEndpoint: observed.properties?.eventStreamEndpoint,
  principalId: observed.identity?.principalId,
  tags: userTags(observed.tags),
  ...extras,
});

/** Generated entry of an Effect job: raise the runtime flag, run the program. */
const effectEntry = (handler: string) => (importPath: string) =>
  `
import { bootstrap } from "@alchemy.run/azure/Bootstrap/ContainerAppsJob";

globalThis.__ALCHEMY_RUNTIME__ = true;
const { ${handler}: entrypoint } = await import(${JSON.stringify(importPath)});

await bootstrap(entrypoint);
`;

/** Generated entry of an async job: no Effect, just the handler file. */
const asyncEntry = (handler: string, envKeys: readonly string[]) => (importPath: string) =>
  `
import { run } from "@alchemy.run/azure/Bootstrap/ContainerAppsJobAsync";
import { ${handler} as handler } from ${JSON.stringify(importPath)};

await run(handler, ${JSON.stringify(envKeys)});
`;

const makeBundler = Effect.gen(function* () {
  const virtualEntryPlugin = yield* Bundle.virtualEntryPlugin;
  return Effect.fn(function* (props: JobProps, main: string) {
    const realMain = yield* resolveMainPath(main);
    const cwd = yield* findCwdForBundle(realMain);
    const handler = props.handler ?? "default";
    const envKeys = Object.keys(props.env ?? {}).sort();
    const entry = props.isExternal ? asyncEntry(handler, envKeys) : effectEntry(handler);
    const output = yield* Bundle.build(
      managedIdentityHostBundle({
        ...props.build?.input,
        input: realMain,
        cwd,
        platform: "node",
        resolve: {
          conditionNames: [...Bundle.NODE_CONDITION_NAMES],
          ...props.build?.input?.resolve,
        },
        plugins: [props.build?.input?.plugins, virtualEntryPlugin(entry)],
      }),
      {
        ...props.build?.output,
        format: "esm",
        sourcemap: props.build?.output?.sourcemap ?? false,
        entryFileNames: "index.mjs",
      },
      props.build,
    );
    const files = output.files.map((file) => ({
      path: file.path,
      content:
        typeof file.content === "string" ? new TextEncoder().encode(file.content) : file.content,
    }));
    const codeHash = (yield* sha256Object({
      bundle: output.hash,
      baseImage: props.baseImage ?? DEFAULT_BASE_IMAGE,
      envKeys: props.isExternal ? envKeys : [],
    })).slice(0, 16);
    return { files, codeHash };
  });
});

const envString = (value: unknown): string =>
  typeof value === "string" ? value : packEnvValue(value);

/** How `packEnvValue` encodes a `Redacted` value. */
const REDACTED_MARKER = /^\{"_tag":"Redacted",/;

/** Job secret holding the env var `key` (lowercase letters, digits, `-`). */
const envSecretName = (key: string) =>
  `env-${key
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")}`.slice(0, 253);

/**
 * Container env vars and the job secrets backing the secret ones: a
 * `Redacted` value (or one packed as Redacted) becomes a job secret
 * referenced with `secretRef`.
 */
const toEnv = (vars: Record<string, unknown>) => {
  const env: app.EnvironmentVar[] = [];
  const secrets: app.Secret[] = [];
  for (const key of Object.keys(vars).sort()) {
    const value = vars[key];
    if (value === undefined) continue;
    const packed = Redacted.isRedacted(value) ? packEnvValue(value) : envString(value);
    if (REDACTED_MARKER.test(packed)) {
      const secretRef = envSecretName(key);
      secrets.push({ name: secretRef, value: packed });
      env.push({ name: key, secretRef });
    } else {
      env.push({ name: key, value: packed });
    }
  }
  return { env, secrets };
};

/** Explicit container env wins over generated env. */
const mergeEnv = (
  own: ReadonlyArray<app.EnvironmentVar> | undefined,
  generated: ReadonlyArray<app.EnvironmentVar>,
) => {
  const taken = new Set((own ?? []).map((e) => e.name));
  const merged = [...(own ?? []), ...generated.filter((e) => !taken.has(e.name))];
  return merged.length > 0 ? merged : undefined;
};

const collectBindings = (bindings: ResourceBinding<JobBinding>[]) => {
  const env: Record<string, unknown> = {};
  const grants = new Map<string, JobRoleAssignment>();
  const rules = new Map<string, JobScaleRule>();
  const schedules = new Set<string>();
  const active = bindings.filter(
    (b: ResourceBinding<JobBinding> & { action?: string }) => b.action !== "delete",
  );
  for (const binding of active) {
    Object.assign(env, binding.data.env ?? {});
    for (const grant of binding.data.roleAssignments ?? []) {
      grants.set(`${grant.scope.toLowerCase()}|${grant.roleDefinitionId.toLowerCase()}`, grant);
    }
    for (const rule of binding.data.scaleRules ?? []) rules.set(rule.name, rule);
    if (binding.data.schedule !== undefined) schedules.add(binding.data.schedule);
  }
  return {
    env,
    grants: [...grants.values()],
    scaleRules: [...rules.values()],
    schedules: [...schedules],
  };
};

type CollectedBindings = ReturnType<typeof collectBindings>;

/** Identity with SystemAssigned enabled, as the registry pull and grants need it. */
const withSystemIdentity = (identity: ContainerAppsIdentity | undefined): ContainerAppsIdentity => {
  if (identity === undefined) return { type: "SystemAssigned" };
  switch (identity.type) {
    case undefined:
    case "None":
      return { type: "SystemAssigned" };
    case "UserAssigned":
      return { ...identity, type: "SystemAssigned,UserAssigned" };
    default:
      return identity;
  }
};

/** Default replica timeout: 30 minutes. */
const DEFAULT_REPLICA_TIMEOUT = 1800;

/** The job's configuration with the trigger its event sources and schedule ask for. */
const toConfiguration = Effect.fn(function* (
  jobName: string,
  configuration: JobConfiguration | undefined,
  collected: CollectedBindings,
) {
  const base = {
    replicaTimeout: DEFAULT_REPLICA_TIMEOUT,
    replicaRetryLimit: 0,
    ...configuration,
  };
  if (
    collected.schedules.length > 1 ||
    (collected.schedules.length > 0 && collected.scaleRules.length > 0)
  ) {
    return yield* new JobTriggerConflict({
      jobName,
      message: `job ${jobName} has more than one trigger (schedules: ${collected.schedules.join(", ") || "none"}; scale rules: ${collected.scaleRules.map((r) => r.name).join(", ") || "none"}); a job runs on one trigger`,
    });
  }
  if (collected.scaleRules.length > 0) {
    const event = configuration?.eventTriggerConfig;
    const config: JobConfiguration = {
      ...base,
      triggerType: "Event",
      manualTriggerConfig: undefined,
      scheduleTriggerConfig: undefined,
      eventTriggerConfig: {
        parallelism: 1,
        replicaCompletionCount: 1,
        ...event,
        scale: {
          minExecutions: 0,
          maxExecutions: 10,
          pollingInterval: 30,
          ...event?.scale,
          rules: [...(event?.scale?.rules ?? []), ...collected.scaleRules],
        },
      },
    };
    return config;
  }
  const cron = collected.schedules[0];
  if (cron !== undefined) {
    const config: JobConfiguration = {
      ...base,
      triggerType: "Schedule",
      manualTriggerConfig: undefined,
      eventTriggerConfig: undefined,
      scheduleTriggerConfig: {
        parallelism: 1,
        replicaCompletionCount: 1,
        ...configuration?.scheduleTriggerConfig,
        cronExpression: cron,
      },
    };
    return config;
  }
  if (configuration !== undefined) {
    // `base` spreads the optional `configuration`; re-spread the narrowed one.
    const config: JobConfiguration = { ...base, ...configuration };
    return config;
  }
  const config: JobConfiguration = {
    ...base,
    triggerType: "Manual",
    manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 },
  };
  return config;
});

export const JobProvider = () =>
  Provider.effect(
    Job,
    Effect.gen(function* () {
      const bundle = yield* makeBundler;

      return Job.Provider.of({
        stables: ["jobName", "jobId", "resourceGroup", "location"],

        nuke: {
          dependsOn: ["Azure.ContainerApps.ManagedEnvironment", "Azure.Resources.ResourceGroup"],
        },

        list: Effect.fn(function* () {
          const { subscriptionId } = yield* AzureEnvironment.current;
          const page = yield* collectAll(app.ListJobBySubscription, { subscriptionId });
          return (page.value ?? []).flatMap((observed) => {
            const group = resourceGroupOf(observed.id);
            return hasAnyAlchemyTag(observed.tags) &&
              group !== undefined &&
              observed.name !== undefined
              ? [
                  toAttrs(group, observed.name, observed, {
                    image: undefined,
                    codeHash: undefined,
                    configHash: undefined,
                  }),
                ]
              : [];
          });
        }),

        diff: Effect.fn(function* ({ news, output }) {
          if (!isResolved(news) || output === undefined) return undefined;
          const props = news as JobProps;
          if (
            (props.resourceGroup !== undefined &&
              lower(props.resourceGroup) !== lower(output.resourceGroup)) ||
            (props.name !== undefined && props.name !== output.jobName) ||
            (props.location !== undefined && !sameLocation(props.location, output.location)) ||
            lower(props.environmentId) !== lower(output.environmentId)
          ) {
            return { action: "replace" } as const;
          }
          // A code-only change leaves the props untouched: compare bundles.
          if (props.main !== undefined) {
            const { codeHash } = yield* bundle(props, props.main);
            if (codeHash !== output.codeHash) return { action: "update" } as const;
          }
          return undefined;
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const { subscriptionId } = yield* AzureEnvironment.current;
          const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
          if (resourceGroup === undefined) return undefined;
          const name = output?.jobName ?? olds?.name ?? (yield* createJobName(id));
          const observed = yield* getJob(subscriptionId, resourceGroup, name);
          if (observed === undefined) return undefined;
          const attrs = toAttrs(resourceGroup, name, observed, {
            image: output?.image,
            codeHash: output?.codeHash,
            configHash: output?.configHash,
          });
          return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, olds, output, bindings }) {
          const env = yield* AzureEnvironment.current;
          const { subscriptionId } = env;
          yield* ensureRegistered(subscriptionId, "Microsoft.App");
          const resourceGroup = news.resourceGroup ?? output?.resourceGroup;
          if (resourceGroup === undefined) {
            return yield* new JobResourceGroupMissing({
              message: `Azure.ContainerApps.Job "${id}" has no resource group`,
            });
          }
          const name = news.name ?? output?.jobName ?? (yield* createJobName(id));
          const location = news.location ?? output?.location ?? env.location;
          const tags = yield* desiredTags(id, news.tags);
          const collected = collectBindings(bindings as ResourceBinding<JobBinding>[]);
          const where = { subscriptionId, resourceGroupName: resourceGroup, jobName: name };

          // The program's image, built in the registry when the code changed.
          let program:
            | { image: string; codeHash: string; loginServer: string; registryId: string }
            | undefined;
          if (news.main !== undefined) {
            const hosting = news.hosting;
            if (hosting === undefined) {
              return yield* new JobImageMissing({
                message: `Azure.ContainerApps.Job "${id}" has no registry for its image`,
              });
            }
            const registry = yield* orUndefinedIfNotFound(
              containerregistry.GetRegistry({
                subscriptionId,
                resourceGroupName: hosting.registryResourceGroup,
                registryName: hosting.registryName,
              }),
            );
            const loginServer = registry?.properties?.loginServer;
            if (registry?.id === undefined || loginServer === undefined) {
              return yield* new JobRegistryNotFound({
                registryName: hosting.registryName,
                message: `container registry ${hosting.registryName} in ${hosting.registryResourceGroup} does not exist`,
              });
            }
            const { files, codeHash } = yield* bundle(news, news.main);
            const image = yield* pushProgramImage({
              subscriptionId,
              resourceGroup: hosting.registryResourceGroup,
              registryName: hosting.registryName,
              loginServer,
              repository: hosting.repository,
              tag: codeHash,
              baseImage: news.baseImage ?? DEFAULT_BASE_IMAGE,
              files,
              entrypoint: ["/app/index.mjs"],
            }).pipe(
              // Concurrent imports of one base into a registry list the
              // index in every repository at once, but its platform
              // manifests reach the later repositories about a minute after.
              Effect.retry({
                while: (e) => e._tag === "Azure.ContainerApps.ImageBuildFailed",
                schedule: Schedule.spaced("15 seconds"),
                times: 12,
              }),
            );
            program = { image, codeHash, loginServer, registryId: registry.id };
          } else if ((news.template?.containers ?? []).length === 0) {
            return yield* new JobImageMissing({
              message: `Azure.ContainerApps.Job "${id}" needs \`main\` or \`template.containers\``,
            });
          }

          // Env: the runtime's stack identity, then binding env, then the user's env.
          const stack = yield* Stack;
          const vars: Record<string, unknown> =
            program === undefined
              ? { ...collected.env, ...news.env }
              : {
                  ALCHEMY_STACK_NAME: stack.name,
                  ALCHEMY_STAGE: stack.stage,
                  ALCHEMY_PHASE: "runtime",
                  ...collected.env,
                  ...news.env,
                };
          const generated = toEnv(vars);

          const configuration = yield* toConfiguration(name, news.configuration, collected);
          const secrets = [...toSecrets(news.secrets), ...generated.secrets];
          const registries: app.RegistryCredentials[] = [
            ...(configuration.registries ?? []),
            ...(program === undefined ? [] : [{ server: program.loginServer, identity: "system" }]),
          ];
          const grants: JobRoleAssignment[] = [
            ...collected.grants,
            ...(program === undefined
              ? []
              : [{ roleDefinitionId: ACR_PULL, scope: program.registryId }]),
          ];
          const identity =
            program !== undefined || grants.length > 0
              ? withSystemIdentity(news.identity)
              : news.identity;

          const [first, ...rest] = news.template?.containers ?? [];
          const containers: app.ContainerInput[] =
            program === undefined
              ? (news.template?.containers ?? []).map((c) => ({
                  ...c,
                  env: mergeEnv(c.env, generated.env),
                }))
              : [
                  {
                    ...first,
                    name: first?.name ?? "main",
                    image: program.image,
                    resources: first?.resources ?? {
                      cpu: news.cpu ?? 0.5,
                      memory: news.memory ?? "1Gi",
                    },
                    env: mergeEnv(first?.env, generated.env),
                  },
                  ...rest,
                ];
          const properties: app.JobPropertiesInput = {
            environmentId: news.environmentId,
            workloadProfileName: news.workloadProfileName,
            configuration: {
              ...configuration,
              secrets,
              registries: registries.length > 0 ? registries : undefined,
            },
            template: { ...news.template, containers },
          };
          const configHash = (yield* sha256Object({
            body: fingerprint({ properties, identity, tags, location }),
          })).slice(0, 16);

          const get = getJob(subscriptionId, resourceGroup, name);
          const put = (body: app.JobPropertiesInput) =>
            app.JobsCreateOrUpdate({
              ...where,
              location,
              tags,
              identity: toIdentity(identity),
              properties: body,
            });
          const ready = waitForProvisioned(
            `container apps job ${name}`,
            get,
            (job) => job.properties?.provisioningState,
            { interval: "5 seconds", times: 60 },
          );

          // Observe.
          let observed = yield* get;
          if (observed !== undefined) observed = yield* ready;

          // Ensure. A program's image is pulled with the job's own identity,
          // which exists only once the job does: create the job on a public
          // image first, grant AcrPull, then switch to the program's image.
          if (
            observed === undefined ||
            (program !== undefined && observed.identity?.principalId === undefined)
          ) {
            yield* put(
              program === undefined
                ? properties
                : {
                    ...properties,
                    configuration: {
                      ...configuration,
                      secrets,
                      registries: configuration.registries,
                    },
                    template: {
                      ...news.template,
                      containers: containers.map((c) => ({ ...c, image: PLACEHOLDER_IMAGE })),
                    },
                  },
            );
            observed = yield* ready;
          }

          // Grants: binding roles and AcrPull, on the observed identity.
          const principalId = observed.identity?.principalId;
          if (principalId !== undefined && observed.id !== undefined) {
            yield* syncBindingAssignments({
              id,
              subscriptionId,
              appId: observed.id,
              principalId,
              grants,
            });
          }

          // Sync against the observed job; secret values via `listSecrets`.
          const observedSecrets =
            secrets.length > 0 || (observed.properties?.configuration?.secrets ?? []).length > 0
              ? (yield* orUndefinedIfNotFound(app.ListJobSecrets(where)))?.value
              : [];
          const inSync =
            matchesDesired(
              { ...properties, configuration: { ...properties.configuration, secrets: undefined } },
              observed.properties,
            ) &&
            secretsMatch(secrets, observedSecrets) &&
            identityMatches(identity, observed.identity) &&
            !tagsDiffer(observed.tags, tags) &&
            (olds === undefined || output?.configHash === configHash);
          if (!inSync) {
            // A new AcrPull assignment takes a minute or two to apply.
            yield* put(properties).pipe(
              Effect.retry({
                while: (e) => e._tag === "ContainerAppsImagePullDenied",
                schedule: Schedule.spaced("15 seconds"),
                times: 12,
              }),
            );
            observed = yield* ready;
          }

          return toAttrs(resourceGroup, name, observed, {
            image: program?.image,
            codeHash: program?.codeHash,
            configHash,
          });
        }),

        delete: Effect.fn(function* ({ id, output }) {
          const { subscriptionId } = yield* AzureEnvironment.current;
          const observed = yield* getJob(subscriptionId, output.resourceGroup, output.jobName);
          // Role assignments outlive their principal; revoke them first.
          const principalId = observed?.identity?.principalId ?? output.principalId;
          if (principalId !== undefined) {
            yield* syncBindingAssignments({
              id,
              subscriptionId,
              appId: observed?.id ?? output.jobId,
              principalId,
              grants: [],
            });
          }
          if (observed === undefined) return;
          yield* ignoreNotFound(
            app.DeleteJob({
              subscriptionId,
              resourceGroupName: output.resourceGroup,
              jobName: output.jobName,
            }),
          );
          yield* waitUntilGone(
            `container apps job ${output.jobName}`,
            getJob(subscriptionId, output.resourceGroup, output.jobName),
            { interval: "5 seconds", times: 60 },
          );
        }),
      });
    }),
  );
