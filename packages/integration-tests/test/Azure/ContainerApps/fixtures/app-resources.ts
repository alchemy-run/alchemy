import * as Azure from "@alchemy.run/azure";
import * as Effect from "effect/Effect";
import { CONSUMPTION_PROFILES, STANDARD_LOCATION } from "./shared.ts";

// Resources the Container App runtime fixtures share. Module-scope so the
// fixtures and the test yield the same declarations.

/** Region of the environment and of the apps in it. */
export const APP_LOCATION = STANDARD_LOCATION;

/**
 * A Workload Profiles environment (Consumption profile): runtime apps need
 * a system-assigned identity and KEDA scalers, which Express lacks.
 */
export const AppEnvironment = Azure.ContainerApps.ManagedEnvironment("AppEnv", {
  location: APP_LOCATION,
  workloadProfiles: CONSUMPTION_PROFILES,
});

export const AppData = Azure.Storage.StorageAccount("AppData");

/** Where every event-source handler records that it ran (`<source>/<id>`). */
export const AppResults = Effect.gen(function* () {
  const account = yield* AppData;
  return yield* Azure.Storage.BlobContainer("AppResults", {
    storageAccount: account.storageAccountName,
  });
});

/** Consumed by the Storage queue event source. */
export const AppJobs = Effect.gen(function* () {
  const account = yield* AppData;
  return yield* Azure.Storage.Queue("AppJobs", { storageAccount: account.storageAccountName });
});

// Standard: topics need it.
export const AppBus = Azure.ServiceBus.Namespace("AppBus", { sku: "Standard" });

/** Consumed by the Service Bus queue event source. */
export const AppOrders = Effect.gen(function* () {
  const bus = yield* AppBus;
  return yield* Azure.ServiceBus.Queue("AppOrders", { namespace: bus.namespaceName });
});

export const AppEvents = Effect.gen(function* () {
  const bus = yield* AppBus;
  return yield* Azure.ServiceBus.Topic("AppEvents", { namespace: bus.namespaceName });
});

/** Consumed by the Service Bus subscription event source. */
export const AppAudit = Effect.gen(function* () {
  const bus = yield* AppBus;
  const events = yield* AppEvents;
  return yield* Azure.ServiceBus.Subscription("AppAudit", {
    namespace: bus.namespaceName,
    topic: events.topicName,
  });
});
