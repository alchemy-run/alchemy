import * as Azure from "@alchemy.run/azure";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { CONSUMPTION_PROFILES } from "./shared.ts";

// Resources the job runtime fixtures share. Module-scope so the fixtures
// and the test yield the same declarations.

/**
 * Region of the job runtime suite. Most regions allow one standard
 * environment per subscription, so this suite keeps away from the other
 * Container Apps suites' `westus2`.
 */
export const JOB_LOCATION = process.env.AZURE_TEST_CONTAINERAPPS_JOB_LOCATION ?? "westus3";

/** One standard environment for every job in the suite (jobs cannot run on Express). */
export const JobEnv = Azure.ContainerApps.ManagedEnvironment("JobEnv", {
  location: JOB_LOCATION,
  workloadProfiles: CONSUMPTION_PROFILES,
});

export const JobData = Azure.Storage.StorageAccount("JobData", { location: JOB_LOCATION });

/** Where every job records that it ran (`<source>/<id>`). */
export const JobResults = Effect.gen(function* () {
  const account = yield* JobData;
  return yield* Azure.Storage.BlobContainer("JobResults", {
    storageAccount: account.storageAccountName,
  });
});

/** Consumed by `QueueJob`; `EffectJob` sends to it. */
export const JobWork = Effect.gen(function* () {
  const account = yield* JobData;
  return yield* Azure.Storage.Queue("JobWork", { storageAccount: account.storageAccountName });
});

export const JobBus = Azure.ServiceBus.Namespace("JobBus", {
  location: JOB_LOCATION,
  sku: "Standard",
});

/** Consumed by `ServiceBusJob`; `EffectJob` sends to it. */
export const JobOrders = Effect.gen(function* () {
  const bus = yield* JobBus;
  return yield* Azure.ServiceBus.Queue("JobOrders", { namespace: bus.namespaceName });
});

/** Registry the event-driven and async jobs share (`EffectJob` gets its own). */
export const JobRegistry = Azure.ContainerRegistry.Registry("JobRegistry", {
  location: JOB_LOCATION,
  sku: "Basic",
});

/** Props every fixture job shares: the environment and the shared registry. */
export const sharedJobProps = Effect.gen(function* () {
  const env = yield* JobEnv;
  const registry = yield* JobRegistry;
  return {
    location: JOB_LOCATION,
    environmentId: env.environmentId,
    registry: { registryName: registry.registryName, resourceGroup: registry.resourceGroup },
    cpu: 0.25,
    memory: "0.5Gi",
  };
});

/**
 * Async (non-Effect) job: `async-job.ts` default-exports `{ run(env) }`,
 * typed with {@link AsyncJobEnv}. It fails unless `env` decodes as declared.
 */
export const AsyncJob = Effect.gen(function* () {
  const shared = yield* sharedJobProps;
  const results = yield* JobResults;
  return yield* Azure.ContainerApps.Job("AsyncJob", {
    ...shared,
    main: `${import.meta.dirname}/async-job.ts`,
    configuration: { triggerType: "Manual", replicaTimeout: 300, replicaRetryLimit: 0 },
    env: {
      GREETING: Config.String("AZURE_JOB_ASYNC_GREETING").pipe(Config.withDefault("hello")),
      SECRET: Redacted.make("s3cret"),
      CONTAINER: results,
    },
  });
});

export type AsyncJobEnv = Azure.InferEnv<typeof AsyncJob>;
