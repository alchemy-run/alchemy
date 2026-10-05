import * as Azure from "@/Azure";
import type { AzureOpError } from "@distilled.cloud/azure";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const tags = ["provider:azure", "provider:azure:apimanagement", "live"];

/**
 * Resource group + Consumption API Management service shared by the child
 * entity tests. Consumption has no idle cost and provisions in ~3 minutes.
 */
export const consumptionService = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("Group", {
    location: "eastus",
  });
  const service = yield* Azure.ApiManagement.Service("Gateway", {
    resourceGroup: group.resourceGroupName,
    publisherEmail: "ops@example.com",
    publisherName: "Alchemy",
  });
  return { group, service };
});

/** Subscription id of the test environment. */
export const subscriptionId = Effect.map(
  Azure.AzureEnvironment.current,
  (env) => env.subscriptionId,
);

/**
 * Poll `get` until it fails with a typed not-found error. Bounded; returns
 * `"found"` if the entity is still there after the last poll.
 */
export const untilGone = <A, R>(get: Effect.Effect<A, AzureOpError, R>) =>
  get.pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "NotFound", "ResourceGroupNotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 12,
    }),
  );

/**
 * Resource group + Developer-tier service for entities Consumption lacks
 * (groups, self-hosted gateways). Developer bills ~$0.07/h but provisions
 * in 30-45 minutes, so tests using it are gated behind `runExpensive`.
 */
export const developerService = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("Group", {
    location: "eastus",
  });
  const service = yield* Azure.ApiManagement.Service("Developer", {
    resourceGroup: group.resourceGroupName,
    sku: { name: "Developer", capacity: 1 },
    publisherEmail: "ops@example.com",
    publisherName: "Alchemy",
  });
  return { group, service };
});

/** Consumption service plus one API (`alchemy-hello`) for API-scoped entities. */
export const consumptionApi = Effect.gen(function* () {
  const { group, service } = yield* consumptionService;
  const api = yield* Azure.ApiManagement.Api("Hello", {
    resourceGroup: group.resourceGroupName,
    serviceName: service.serviceName,
    name: "alchemy-hello",
    path: "hello",
    serviceUrl: "https://example.com",
  });
  return { group, service, api };
});

/**
 * Resource group + BasicV2 service for entities that need the developer
 * portal (users, groups, notifications, identity providers) or workspaces.
 * BasicV2 bills ~$0.21/h and takes 5-15+ minutes to create, so tests using
 * it are gated behind `runExpensive`.
 */
export const basicV2Service = Effect.gen(function* () {
  // BasicV2 activations in eastus have queued for 30-50 minutes; westus
  // activates in ~2.
  const group = yield* Azure.Resources.ResourceGroup("Group", {
    location: "westus",
  });
  const service = yield* Azure.ApiManagement.Service("Portal", {
    resourceGroup: group.resourceGroupName,
    location: "westus",
    sku: { name: "BasicV2", capacity: 1 },
    publisherEmail: "ops@example.com",
    publisherName: "Alchemy",
  });
  return { group, service };
});

/** BasicV2 service plus one workspace (`alchemy-ws`) for workspace-scoped entities. */
export const basicV2Workspace = Effect.gen(function* () {
  const { group, service } = yield* basicV2Service;
  const workspace = yield* Azure.ApiManagement.Workspace("Team", {
    resourceGroup: group.resourceGroupName,
    serviceName: service.serviceName,
    name: "alchemy-ws",
    displayName: "Alchemy team",
  });
  return { group, service, workspace };
});

/** Consumption service plus a synthetic GraphQL API with a schema. */
export const consumptionGraphQLApi = Effect.gen(function* () {
  const { group, service } = yield* consumptionService;
  const api = yield* Azure.ApiManagement.Api("Graph", {
    resourceGroup: group.resourceGroupName,
    serviceName: service.serviceName,
    name: "alchemy-graphql",
    path: "graphql",
    type: "graphql",
    protocols: ["https"],
  });
  const schema = yield* Azure.ApiManagement.ApiSchema("GraphSchema", {
    resourceGroup: group.resourceGroupName,
    serviceName: service.serviceName,
    apiName: api.apiName,
    name: "graphql",
    contentType: "application/vnd.ms-azure-apim.graphql.schema",
    value: "type Query {\n  hello: String\n  users: [String]\n}\n",
  });
  return { group, service, api, schema };
});

/** BasicV2 service plus one API (`alchemy-hello`). */
export const basicV2Api = Effect.gen(function* () {
  const { group, service } = yield* basicV2Service;
  const api = yield* Azure.ApiManagement.Api("Hello", {
    resourceGroup: group.resourceGroupName,
    serviceName: service.serviceName,
    name: "alchemy-hello",
    path: "hello",
    serviceUrl: "https://example.com",
  });
  return { group, service, api };
});

/** Developer service plus one self-hosted gateway (`alchemy-edge`). */
export const developerGateway = Effect.gen(function* () {
  const { group, service } = yield* developerService;
  const gateway = yield* Azure.ApiManagement.Gateway("Edge", {
    resourceGroup: group.resourceGroupName,
    serviceName: service.serviceName,
    name: "alchemy-edge",
    locationData: { name: "dc1" },
  });
  return { group, service, gateway };
});
