import * as cosmos from "@distilled.cloud/azure/cosmos_db";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { whileAccountBusy } from "./Shared.ts";

/** Kind of dedicated compute. The service is named after its type. */
export type ServiceType =
  | "SqlDedicatedGateway"
  | "DataTransfer"
  | "GraphAPICompute"
  | "MaterializedViewsBuilder";

/** Size of each service instance. */
export type ServiceInstanceSize = "Cosmos.D4s" | "Cosmos.D8s" | "Cosmos.D16s";

export interface ServiceProps {
  /** Resource group of the account. Changing it replaces the service. */
  resourceGroup: string;
  /**
   * Name of a provisioned-throughput Cosmos DB account (serverless accounts
   * do not support dedicated compute). Changing it replaces the service.
   */
  account: string;
  /**
   * Kind of dedicated compute; the service is named after it, so an
   * account has at most one service per type. Changing it replaces the
   * service.
   */
  serviceType: ServiceType;
  /**
   * Instance size. Updated in place.
   * @default "Cosmos.D4s"
   */
  instanceSize?: ServiceInstanceSize;
  /**
   * Number of instances. Updated in place.
   * @default 1
   */
  instanceCount?: number;
}

export interface Service extends Resource<
  "Azure.CosmosDB.Service",
  ServiceProps,
  {
    /** Name of the service (equal to its type). */
    serviceName: string;
    /** Kind of dedicated compute. */
    serviceType: string;
    /** ARM resource ID of the service. */
    serviceId: string;
    /** Name of the Cosmos DB account. */
    account: string;
    /** Resource group of the account. */
    resourceGroup: string;
    /** Instance size. */
    instanceSize: string | undefined;
    /** Number of instances. */
    instanceCount: number | undefined;
    /** Service status, e.g. `Running`. */
    status: string | undefined;
  },
  never,
  Providers
> {}

/**
 * Dedicated compute attached to an Azure Cosmos DB account: the integrated
 * cache (`SqlDedicatedGateway`), container copy jobs (`DataTransfer`),
 * Gremlin compute (`GraphAPICompute`), or materialized views
 * (`MaterializedViewsBuilder`).
 *
 * Instances are billed per hour while the service exists. The service is
 * named after its type and cannot be tagged, so Alchemy only adopts one it
 * recorded itself.
 *
 * @see https://learn.microsoft.com/azure/cosmos-db/dedicated-gateway
 *
 * ### Integrated Cache
 * **Example:** One-node dedicated gateway
 * ```typescript
 * const gateway = yield* Azure.CosmosDB.Service("gateway", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   serviceType: "SqlDedicatedGateway",
 *   instanceSize: "Cosmos.D4s",
 *   instanceCount: 1,
 * });
 * ```
 *
 * ### Data Transfer
 * **Example:** Compute for container copy jobs
 * ```typescript
 * yield* Azure.CosmosDB.Service("copy", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   serviceType: "DataTransfer",
 *   instanceCount: 2,
 * });
 * ```
 *
 * @resource
 */
export const Service = Resource<Service>("Azure.CosmosDB.Service");

type ObservedService = cosmos.GetServiceResponse;

const getService = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  serviceName: string,
) =>
  orUndefinedIfNotFound(
    cosmos.GetService({
      subscriptionId,
      resourceGroupName,
      accountName,
      serviceName,
    }),
  );

/** Map the service status onto the shared provisioning-state vocabulary. */
const stateOf = (service: ObservedService) => {
  const status = service.properties?.status;
  if (status === "Running") return "Succeeded";
  if (status === "Error") return "Failed";
  return status ?? "Creating";
};

const toAttrs = (
  resourceGroup: string,
  account: string,
  service: ObservedService,
  serviceName: string,
): Service["Attributes"] => ({
  serviceName,
  serviceType: service.properties?.serviceType ?? serviceName,
  serviceId: service.id ?? "",
  account,
  resourceGroup,
  instanceSize: service.properties?.instanceSize,
  instanceCount: service.properties?.instanceCount,
  status: service.properties?.status,
});

export const ServiceProvider = () =>
  Provider.succeed(Service, {
    stables: [
      "serviceName",
      "serviceType",
      "serviceId",
      "account",
      "resourceGroup",
    ],

    // Services disappear with their account.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.account !== output.account ||
        news.serviceType !== output.serviceName
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const account = output?.account ?? olds?.account;
      const serviceName = output?.serviceName ?? olds?.serviceType;
      if (
        resourceGroup === undefined ||
        account === undefined ||
        serviceName === undefined
      ) {
        return undefined;
      }
      const observed = yield* getService(
        subscriptionId,
        resourceGroup,
        account,
        serviceName,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, account, observed, serviceName);
      // The name is fixed by the type, so only a service Alchemy recorded
      // is known to be ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.DocumentDB");
      const { resourceGroup, account, serviceType } = news;
      const instanceSize = news.instanceSize ?? "Cosmos.D4s";
      const instanceCount = news.instanceCount ?? 1;
      const label = `Cosmos DB service ${serviceType}`;
      const get = getService(
        subscriptionId,
        resourceGroup,
        account,
        serviceType,
      );

      // Observe.
      let observed = yield* get;

      // Ensure + sync. The PUT is an upsert of size and count.
      if (
        observed === undefined ||
        observed.properties?.instanceSize !== instanceSize ||
        observed.properties?.instanceCount !== instanceCount
      ) {
        yield* cosmos
          .CreateService({
            subscriptionId,
            resourceGroupName: resourceGroup,
            accountName: account,
            serviceName: serviceType,
            properties: { serviceType, instanceSize, instanceCount },
          })
          .pipe(Effect.retry(whileAccountBusy));
      }

      // Block until the instances are running at the desired shape. A
      // failed resize (e.g. regional capacity) leaves the service `Running`
      // at its old shape: once a transition has been observed, returning
      // to `Running` with the wrong shape is a failure, not progress.
      let transitioned = false;
      observed = yield* waitForProvisioned(
        label,
        get,
        (service) => {
          const state = stateOf(service);
          if (
            service.properties?.instanceSize === instanceSize &&
            service.properties?.instanceCount === instanceCount
          ) {
            return state;
          }
          if (state !== "Succeeded") {
            transitioned = true;
            return state;
          }
          return transitioned ? "Failed" : "Updating";
        },
        { interval: "15 seconds", times: 80 },
      );

      return toAttrs(resourceGroup, account, observed, serviceType);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        cosmos
          .DeleteService({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            accountName: output.account,
            serviceName: output.serviceName,
          })
          .pipe(Effect.retry(whileAccountBusy)),
      );
      yield* waitUntilGone(
        `Cosmos DB service ${output.serviceName}`,
        getService(
          subscriptionId,
          output.resourceGroup,
          output.account,
          output.serviceName,
        ),
        { interval: "15 seconds", times: 80 },
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.CosmosDB.DatabaseAccount",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
