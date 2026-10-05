import * as eventhub from "@distilled.cloud/azure/eventhub";
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
import { createNamespaceName, namespaceOwnedByStage } from "./Common.ts";

export interface DisasterRecoveryConfigProps {
  /** Resource group of the primary namespace. Changing it replaces the pairing. */
  resourceGroup: string;
  /** Primary namespace name. Changing it replaces the pairing. */
  namespace: string;
  /**
   * Geo-DR alias: the stable DNS name (`{alias}.servicebus.windows.net`)
   * clients connect to. 6-50 letters, digits, and hyphens, globally unique.
   * If omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the pairing.
   */
  alias?: string;
  /**
   * ARM resource ID of the secondary namespace (another region, same tier,
   * and empty when paired). Changing it replaces the pairing.
   */
  partnerNamespace: string;
  /**
   * Alternate name, required only when the alias equals the primary
   * namespace name. Changing it replaces the pairing.
   */
  alternateName?: string;
}

export interface DisasterRecoveryConfig extends Resource<
  "Azure.EventHub.DisasterRecoveryConfig",
  DisasterRecoveryConfigProps,
  {
    /** Geo-DR alias name. */
    alias: string;
    /** ARM resource ID of the alias on the primary namespace. */
    disasterRecoveryConfigId: string;
    /** Primary namespace name. */
    namespace: string;
    /** Resource group of the primary namespace. */
    resourceGroup: string;
    /** ARM resource ID of the secondary namespace. */
    partnerNamespace: string;
    /** Alternate name, if any. */
    alternateName: string | undefined;
    /** Provisioning state of the pairing (`Accepted`, `Succeeded`, `Failed`). */
    provisioningState: string | undefined;
    /** Role of the primary namespace (`Primary`, `PrimaryNotReplicating`, `Secondary`). */
    role: string | undefined;
    /** Entities still waiting to replicate to the secondary. */
    pendingReplicationOperationsCount: number | undefined;
  },
  never,
  Providers
> {}

/**
 * An Event Hubs Geo-disaster recovery pairing — an alias that pairs a
 * primary namespace with an empty secondary namespace in another region and
 * replicates metadata (event hubs, consumer groups, settings) to it. Clients
 * connect through the alias, which keeps pointing at the active namespace
 * after a failover. Both namespaces must be `Standard` (or higher).
 *
 * Deleting the resource breaks the pairing first (both namespaces keep
 * their entities) and then removes the alias.
 *
 * Pairings have no tags; Alchemy treats one as owned when its primary
 * namespace carries this stack's ownership tags.
 *
 * @see https://learn.microsoft.com/azure/event-hubs/event-hubs-geo-dr
 *
 * ### Pairing Two Namespaces
 * **Example:** Primary in East US, secondary in West US 2
 * ```typescript
 * const primary = yield* Azure.EventHub.Namespace("Primary", {
 *   resourceGroup: group.resourceGroupName,
 *   location: "eastus",
 *   sku: "Standard",
 * });
 * const secondary = yield* Azure.EventHub.Namespace("Secondary", {
 *   resourceGroup: group.resourceGroupName,
 *   location: "westus2",
 *   sku: "Standard",
 * });
 * const geoDr = yield* Azure.EventHub.DisasterRecoveryConfig("GeoDr", {
 *   resourceGroup: group.resourceGroupName,
 *   namespace: primary.namespaceName,
 *   partnerNamespace: secondary.namespaceId,
 * });
 * ```
 *
 * @resource
 */
export const DisasterRecoveryConfig = Resource<DisasterRecoveryConfig>(
  "Azure.EventHub.DisasterRecoveryConfig",
);

const getConfig = (
  subscriptionId: string,
  resourceGroupName: string,
  namespaceName: string,
  alias: string,
) =>
  orUndefinedIfNotFound(
    eventhub.GetDisasterRecoveryConfig({
      subscriptionId,
      resourceGroupName,
      namespaceName,
      alias,
    }),
  );

type ObservedConfig = eventhub.GetDisasterRecoveryConfigResponse;

const toAttrs = (
  resourceGroup: string,
  namespace: string,
  alias: string,
  config: ObservedConfig,
): DisasterRecoveryConfig["Attributes"] => ({
  alias,
  disasterRecoveryConfigId: config.id ?? "",
  namespace,
  resourceGroup,
  partnerNamespace: config.properties?.partnerNamespace ?? "",
  alternateName: config.properties?.alternateName,
  provisioningState: config.properties?.provisioningState,
  role: config.properties?.role,
  pendingReplicationOperationsCount:
    config.properties?.pendingReplicationOperationsCount,
});

/**
 * Poll until the pairing has settled: provisioning finished and, when
 * `role` is given, the primary reports that role.
 */
const waitForRole = (
  description: string,
  get: ReturnType<typeof getConfig>,
  role: string | undefined,
) =>
  waitForProvisioned(
    description,
    get,
    (config) => {
      const state = config.properties?.provisioningState;
      if (state !== undefined && state !== "Succeeded") return state;
      if (role !== undefined && config.properties?.role !== role) {
        return "Accepted";
      }
      return "Succeeded";
    },
    { interval: "5 seconds", times: 60 },
  );

const breakPairing = (
  subscriptionId: string,
  resourceGroupName: string,
  namespaceName: string,
  alias: string,
) =>
  eventhub
    .DisasterRecoveryConfigsBreakPairing({
      subscriptionId,
      resourceGroupName,
      namespaceName,
      alias,
    })
    .pipe(
      Effect.andThen(
        waitForRole(
          `geo-DR alias ${alias} (break pairing)`,
          getConfig(subscriptionId, resourceGroupName, namespaceName, alias),
          "PrimaryNotReplicating",
        ),
      ),
    );

const sameId = (a: string | undefined, b: string | undefined) =>
  (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

export const DisasterRecoveryConfigProvider = () =>
  Provider.succeed(DisasterRecoveryConfig, {
    stables: [
      "alias",
      "disasterRecoveryConfigId",
      "namespace",
      "resourceGroup",
      "partnerNamespace",
      "alternateName",
    ],

    // Aliases live inside a namespace; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.namespace.toLowerCase() !== output.namespace.toLowerCase() ||
        (news.alias !== undefined &&
          news.alias.toLowerCase() !== output.alias.toLowerCase()) ||
        !sameId(news.partnerNamespace, output.partnerNamespace) ||
        (news.alternateName ?? "") !== (output.alternateName ?? "")
      ) {
        // A namespace can be in only one pairing at a time.
        return { action: "replace", deleteFirst: true } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const namespace = output?.namespace ?? olds?.namespace;
      if (resourceGroup === undefined || namespace === undefined) {
        return undefined;
      }
      const alias =
        output?.alias ?? olds?.alias ?? (yield* createNamespaceName(id));
      const observed = yield* getConfig(
        subscriptionId,
        resourceGroup,
        namespace,
        alias,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, namespace, alias, observed);
      return (yield* namespaceOwnedByStage(
        subscriptionId,
        resourceGroup,
        namespace,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.EventHub");
      const { resourceGroup, namespace, partnerNamespace } = news;
      const alias =
        news.alias ?? output?.alias ?? (yield* createNamespaceName(id));
      const get = getConfig(subscriptionId, resourceGroup, namespace, alias);

      // Observe; let an in-flight pairing operation settle first.
      let observed = yield* get;
      if (
        observed !== undefined &&
        observed.properties?.provisioningState === "Accepted"
      ) {
        observed = yield* waitForRole(`geo-DR alias ${alias}`, get, undefined);
      }

      // An alias paired with a different secondary (adoption) must be
      // broken before it can be re-paired.
      if (
        observed?.properties?.role === "Primary" &&
        !sameId(observed.properties.partnerNamespace, partnerNamespace)
      ) {
        observed = yield* breakPairing(
          subscriptionId,
          resourceGroup,
          namespace,
          alias,
        );
      }

      // Ensure: create the alias, or re-pair a broken one.
      if (
        observed === undefined ||
        observed.properties?.role !== "Primary" ||
        !sameId(observed.properties.partnerNamespace, partnerNamespace)
      ) {
        yield* eventhub.DisasterRecoveryConfigsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          namespaceName: namespace,
          alias,
          properties: {
            partnerNamespace,
            alternateName: news.alternateName,
          },
        });
      }

      // Pairing is asynchronous; block until replication is established.
      const fresh = yield* waitForRole(`geo-DR alias ${alias}`, get, "Primary");
      return toAttrs(resourceGroup, namespace, alias, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const { resourceGroup, namespace, alias } = output;
      const get = getConfig(subscriptionId, resourceGroup, namespace, alias);
      let observed = yield* get;
      if (observed === undefined) return;
      if (observed.properties?.provisioningState === "Accepted") {
        observed = yield* waitForRole(`geo-DR alias ${alias}`, get, undefined);
      }
      // The alias can only be deleted once the pairing is broken.
      if (observed.properties?.role === "Primary") {
        yield* breakPairing(subscriptionId, resourceGroup, namespace, alias);
      }
      yield* ignoreNotFound(
        eventhub.DeleteDisasterRecoveryConfig({
          subscriptionId,
          resourceGroupName: resourceGroup,
          namespaceName: namespace,
          alias,
        }),
      );
      yield* waitUntilGone(`geo-DR alias ${alias}`, get, {
        interval: "5 seconds",
        times: 60,
      });
    }),

    nuke: {
      dependsOn: ["Azure.EventHub.Namespace", "Azure.Resources.ResourceGroup"],
    },
  });
