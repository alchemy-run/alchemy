import * as servicebus from "@distilled.cloud/azure/servicebus";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  DeleteTimedOut,
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { createEntityName, sameName } from "./internal.ts";

export interface DisasterRecoveryConfigProps {
  /**
   * Resource group of the primary namespace. Changing it replaces the
   * pairing.
   */
  resourceGroup: string;
  /** Primary Premium namespace. Changing it replaces the pairing. */
  namespace: string;
  /**
   * ARM resource ID of the secondary Premium namespace (in another region).
   * It must hold no entities. Changing it replaces the pairing.
   */
  partnerNamespace: string;
  /**
   * Alias name — a globally unique DNS name
   * (`<alias>.servicebus.windows.net`) clients use to reach whichever
   * namespace is currently primary. 1-50 letters, digits, and hyphens,
   * starting with a letter and ending with a letter or digit. If omitted, a
   * unique lowercase name is generated from the app, stage, and logical ID.
   * Changing it replaces the pairing.
   */
  name?: string;
  /**
   * Alternate name for the primary namespace; required only when the alias
   * equals the primary namespace's name. Changing it replaces the pairing.
   */
  alternateName?: string;
}

export interface DisasterRecoveryConfig extends Resource<
  "Azure.ServiceBus.DisasterRecoveryConfig",
  DisasterRecoveryConfigProps,
  {
    /** Alias (Geo-DR configuration) name. */
    alias: string;
    /** ARM resource ID of the alias. */
    disasterRecoveryConfigId: string;
    /** Primary namespace the alias is configured on. */
    namespaceName: string;
    /** Resource group of the primary namespace. */
    resourceGroup: string;
    /** ARM resource ID of the secondary namespace. */
    partnerNamespace: string | undefined;
    /** Alternate name of the primary namespace, if set. */
    alternateName: string | undefined;
    /** Role of the namespace: `Primary`, `PrimaryNotReplicating`, or `Secondary`. */
    role: string | undefined;
    /** Provisioning state: `Accepted`, `Succeeded`, or `Failed`. */
    provisioningState: string | undefined;
    /** Number of entities still pending replication. */
    pendingReplicationOperationsCount: number | undefined;
  },
  never,
  Providers
> {}

/**
 * A Service Bus Geo-Disaster Recovery alias that pairs a primary Premium
 * namespace with a secondary Premium namespace in another region and
 * continuously replicates metadata (entities, rules, settings) to it.
 * Clients connect through the alias; a failover repoints the alias to the
 * secondary.
 *
 * Creating the pairing blocks until replication reaches `Succeeded`.
 * Deleting it breaks the pairing first and then removes the alias, after
 * which both namespaces are independent and can be deleted.
 *
 * Aliases have no tags or metadata: Alchemy treats an alias it did not
 * create as unowned and only takes it over with `--adopt`.
 *
 * @see https://learn.microsoft.com/azure/service-bus-messaging/service-bus-geo-dr
 *
 * ### Pairing Namespaces
 * **Example:** Primary in East US, secondary in West US
 * ```typescript
 * const primary = yield* Azure.ServiceBus.Namespace("primary", {
 *   resourceGroup: group.resourceGroupName,
 *   location: "eastus",
 *   sku: "Premium",
 * });
 * const secondary = yield* Azure.ServiceBus.Namespace("secondary", {
 *   resourceGroup: group.resourceGroupName,
 *   location: "westus",
 *   sku: "Premium",
 * });
 * const geoDr = yield* Azure.ServiceBus.DisasterRecoveryConfig("geo-dr", {
 *   resourceGroup: group.resourceGroupName,
 *   namespace: primary.namespaceName,
 *   partnerNamespace: secondary.namespaceId,
 * });
 * // clients connect to `${geoDr.alias}.servicebus.windows.net`
 * ```
 *
 * @resource
 */
export const DisasterRecoveryConfig = Resource<DisasterRecoveryConfig>(
  "Azure.ServiceBus.DisasterRecoveryConfig",
);

interface Where {
  subscriptionId: string;
  resourceGroupName: string;
  namespaceName: string;
  alias: string;
}

const getConfig = (where: Where) =>
  orUndefinedIfNotFound(servicebus.GetDisasterRecoveryConfig(where));

/** Alias names are DNS labels and must start with a letter. */
const createAliasName = Effect.fn(function* (id: string) {
  const name = yield* createEntityName(id, 50);
  return name.replace(/^[^a-z]+/, "");
});

const toAttrs = (
  where: Where,
  config: servicebus.GetDisasterRecoveryConfigResponse,
): DisasterRecoveryConfig["Attributes"] => ({
  alias: where.alias,
  disasterRecoveryConfigId: config.id ?? "",
  namespaceName: where.namespaceName,
  resourceGroup: where.resourceGroupName,
  partnerNamespace: config.properties?.partnerNamespace,
  alternateName: config.properties?.alternateName,
  role: config.properties?.role,
  provisioningState: config.properties?.provisioningState,
  pendingReplicationOperationsCount:
    config.properties?.pendingReplicationOperationsCount,
});

/** Poll until the alias settles (`Succeeded`); pairing copies metadata. */
const waitSettled = (where: Where) =>
  waitForProvisioned(
    `service bus geo-dr alias ${where.alias}`,
    getConfig(where),
    (config) => config.properties?.provisioningState,
    { interval: "10 seconds", times: 60 },
  );

/** Poll until the broken pairing settles as `PrimaryNotReplicating`. */
const waitUnpaired = (where: Where) =>
  getConfig(where).pipe(
    Effect.flatMap((config) =>
      config === undefined ||
      (config.properties?.role === "PrimaryNotReplicating" &&
        config.properties?.provisioningState === "Succeeded")
        ? Effect.void
        : Effect.fail("pending" as const),
    ),
    Effect.retry({
      while: (e) => e === "pending",
      schedule: Schedule.spaced("10 seconds"),
      times: 60,
    }),
    Effect.catchIf(
      (e): e is "pending" => e === "pending",
      () =>
        Effect.fail(
          new DeleteTimedOut({
            resource: `service bus geo-dr alias ${where.alias}`,
            message: `geo-dr alias ${where.alias} did not finish breaking its pairing`,
          }),
        ),
    ),
  );

export const DisasterRecoveryConfigProvider = () =>
  Provider.succeed(DisasterRecoveryConfig, {
    stables: [
      "alias",
      "disasterRecoveryConfigId",
      "namespaceName",
      "resourceGroup",
    ],

    // Aliases live inside a namespace; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.namespace, output.namespaceName) ||
        (news.name !== undefined && !sameName(news.name, output.alias)) ||
        (olds !== undefined &&
          !sameName(news.partnerNamespace, olds.partnerNamespace)) ||
        (olds !== undefined && news.alternateName !== olds.alternateName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroupName = output?.resourceGroup ?? olds?.resourceGroup;
      const namespaceName = output?.namespaceName ?? olds?.namespace;
      if (resourceGroupName === undefined || namespaceName === undefined) {
        return undefined;
      }
      const where = {
        subscriptionId,
        resourceGroupName,
        namespaceName,
        alias: output?.alias ?? olds?.name ?? (yield* createAliasName(id)),
      };
      const observed = yield* getConfig(where);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(where, observed);
      // No tags or metadata: only an alias we already track is provably ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.ServiceBus");
      const where = {
        subscriptionId,
        resourceGroupName: news.resourceGroup,
        namespaceName: news.namespace,
        alias: news.name ?? output?.alias ?? (yield* createAliasName(id)),
      };

      // Observe; a pairing still in progress settles before it is compared.
      const observed = yield* getConfig(where);
      const settled =
        observed === undefined ? undefined : yield* waitSettled(where);

      // Ensure: create the alias, or re-pair it when the pairing was broken
      // (role `PrimaryNotReplicating`) out of band.
      if (
        settled === undefined ||
        settled.properties?.role === "PrimaryNotReplicating"
      ) {
        yield* servicebus.DisasterRecoveryConfigsCreateOrUpdate({
          ...where,
          properties: {
            partnerNamespace: news.partnerNamespace,
            alternateName: news.alternateName,
          },
        });
      }

      const fresh = yield* waitSettled(where);
      return toAttrs(where, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        namespaceName: output.namespaceName,
        alias: output.alias,
      };
      const observed = yield* getConfig(where);
      if (observed === undefined) return;

      // The alias can only be deleted once the pairing is broken.
      const settled = yield* waitSettled(where);
      if (settled.properties?.role === "Primary") {
        yield* ignoreNotFound(
          servicebus.DisasterRecoveryConfigsBreakPairing(where),
        );
        yield* waitUnpaired(where);
      }

      yield* ignoreNotFound(servicebus.DeleteDisasterRecoveryConfig(where));
      yield* waitUntilGone(
        `service bus geo-dr alias ${output.alias}`,
        getConfig(where),
        { interval: "10 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.ServiceBus.Namespace"] },
  });
