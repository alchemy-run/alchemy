import * as servicenetworking from "@distilled.cloud/azure/servicenetworking";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  AGC_BUDGET,
  childLocation,
  createAgcName,
  ensureProvisioned,
  sameArm,
} from "./Common.ts";

export interface AssociationProps {
  /**
   * Resource group of the traffic controller. Changing it replaces the
   * association.
   */
  resourceGroup: string;
  /**
   * Name of the traffic controller that owns the association. A traffic
   * controller holds a single association. Changing it replaces the
   * association.
   */
  trafficController: string;
  /**
   * Association name: up to 64 letters, digits, `-`, `_`, and `.`. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the association.
   */
  name?: string;
  /**
   * Azure location of the association; must match the traffic controller's
   * location. Changing it replaces the association.
   * @default the traffic controller's location
   */
  location?: string;
  /**
   * ARM ID of the subnet Application Gateway for Containers injects into.
   * The subnet must be delegated to
   * `Microsoft.ServiceNetworking/trafficControllers`, be at least `/24`, and
   * hold nothing else. Changing it replaces the association.
   */
  subnetId: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Association extends Resource<
  "Azure.ServiceNetworking.Association",
  AssociationProps,
  {
    /** Name of the association. */
    associationName: string;
    /**
     * ARM resource ID of the association; private frontends reference it.
     */
    associationId: string;
    /** Name of the traffic controller that owns the association. */
    trafficController: string;
    /** Resource group of the traffic controller. */
    resourceGroup: string;
    /** Location of the association. */
    location: string;
    /** Association type (always `subnets`). */
    associationType: string;
    /** ARM ID of the associated subnet. */
    subnetId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An association of an Application Gateway for Containers traffic
 * controller — connects the traffic controller to a delegated subnet of
 * the virtual network your AKS pods run in, so the proxies can reach the
 * backends.
 *
 * Associations bill hourly (about $0.12/hour) and take several minutes to
 * inject into the subnet and to delete. A traffic controller holds one
 * association.
 *
 * @see https://learn.microsoft.com/azure/application-gateway/for-containers/application-gateway-for-containers-components
 *
 * ### Creating an Association
 * **Example:** Association with a delegated subnet
 * ```typescript
 * const vnet = yield* Azure.Network.VirtualNetwork("vnet", {
 *   resourceGroup: group.resourceGroupName,
 *   addressPrefixes: ["10.0.0.0/16"],
 * });
 * const subnet = yield* Azure.Network.Subnet("alb", {
 *   resourceGroup: group.resourceGroupName,
 *   virtualNetwork: vnet.virtualNetworkName,
 *   addressPrefix: "10.0.1.0/24",
 *   delegations: [
 *     { serviceName: "Microsoft.ServiceNetworking/trafficControllers" },
 *   ],
 * });
 * const association = yield* Azure.ServiceNetworking.Association("alb", {
 *   resourceGroup: group.resourceGroupName,
 *   trafficController: controller.trafficControllerName,
 *   subnetId: subnet.subnetId,
 * });
 * ```
 *
 * @resource
 */
export const Association = Resource<Association>(
  "Azure.ServiceNetworking.Association",
);

type Observed =
  | servicenetworking.GetAssociationsInterfaceResponse
  | servicenetworking.Association;

const getAssociation = (
  subscriptionId: string,
  resourceGroupName: string,
  trafficControllerName: string,
  associationName: string,
) =>
  orUndefinedIfNotFound(
    servicenetworking.GetAssociationsInterface({
      subscriptionId,
      resourceGroupName,
      trafficControllerName,
      associationName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  trafficController: string,
  name: string,
  association: Observed,
): Association["Attributes"] => ({
  associationName: name,
  associationId: association.id ?? "",
  trafficController,
  resourceGroup,
  location: association.location,
  associationType: association.properties?.associationType ?? "subnets",
  subnetId: association.properties?.subnet?.id,
  tags: userTags(association.tags),
});

/** Associations inject into a subnet; creating and deleting is slow. */
const ASSOCIATION_BUDGET = { interval: "10 seconds", times: 90 } as const;

export const AssociationProvider = () =>
  Provider.succeed(Association, {
    stables: [
      "associationName",
      "associationId",
      "trafficController",
      "resourceGroup",
      "location",
      "associationType",
      "subnetId",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const controllers = yield* servicenetworking
        .ListTrafficControllerInterfaceBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage(
              "ListTrafficControllerInterfaceBySubscription",
              page,
            ),
          ),
        );
      const found: Association["Attributes"][] = [];
      for (const controller of controllers.value ?? []) {
        const group = resourceGroupOf(controller.id);
        if (group === undefined || controller.name === undefined) continue;
        const page = yield* orUndefinedIfNotFound(
          servicenetworking.ListAssociationsInterfaceByTrafficController({
            subscriptionId,
            resourceGroupName: group,
            trafficControllerName: controller.name,
          }),
        );
        if (page !== undefined) {
          yield* requireSinglePage(
            "ListAssociationsInterfaceByTrafficController",
            page,
          );
        }
        for (const association of page?.value ?? []) {
          if (
            hasAnyAlchemyTag(association.tags) &&
            association.name !== undefined
          ) {
            found.push(
              toAttrs(group, controller.name, association.name, association),
            );
          }
        }
      }
      return found;
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const sameController =
        sameArm(news.resourceGroup, output.resourceGroup) &&
        sameArm(news.trafficController, output.trafficController);
      if (
        !sameController ||
        (news.name !== undefined &&
          !sameArm(news.name, output.associationName)) ||
        (news.location !== undefined &&
          !sameArm(news.location, output.location)) ||
        !sameArm(news.subnetId, output.subnetId)
      ) {
        // A traffic controller holds one association and a delegated subnet
        // one traffic controller: the old association must go first.
        return { action: "replace", deleteFirst: true } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const trafficController =
        output?.trafficController ?? olds?.trafficController;
      if (resourceGroup === undefined || trafficController === undefined) {
        return undefined;
      }
      const name =
        output?.associationName ?? olds?.name ?? (yield* createAgcName(id));
      const observed = yield* getAssociation(
        subscriptionId,
        resourceGroup,
        trafficController,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, trafficController, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.ServiceNetworking");
      const { resourceGroup, trafficController } = news;
      const name =
        news.name ?? output?.associationName ?? (yield* createAgcName(id));
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        trafficControllerName: trafficController,
        associationName: name,
      };
      const get = getAssociation(
        subscriptionId,
        resourceGroup,
        trafficController,
        name,
      );
      const label = `AGC association ${name}`;

      // Observe + ensure: PUT when missing or Failed (long-running), then
      // wait for Succeeded. Children live in the parent's location.
      let observed = yield* ensureProvisioned(
        label,
        get,
        (association) => association.properties?.provisioningState,
        Effect.gen(function* () {
          const location = yield* childLocation(
            subscriptionId,
            resourceGroup,
            trafficController,
            news.location ?? output?.location,
          );
          yield* servicenetworking.AssociationsInterfaceCreateOrUpdate({
            ...where,
            location,
            tags,
            properties: {
              associationType: "subnets",
              subnet: { id: news.subnetId },
            },
          });
        }),
        ASSOCIATION_BUDGET,
      );

      // Sync tags (the subnet is immutable; diff replaces).
      if (tagsDiffer(observed.tags, tags)) {
        yield* servicenetworking.UpdateAssociationsInterface({
          ...where,
          tags,
        });
        observed = yield* waitForProvisioned(
          label,
          get,
          (association) =>
            tagsDiffer(association.tags, tags)
              ? "Updating"
              : association.properties?.provisioningState,
          ASSOCIATION_BUDGET,
        );
      }

      return toAttrs(resourceGroup, trafficController, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        servicenetworking.DeleteAssociationsInterface({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          trafficControllerName: output.trafficController,
          associationName: output.associationName,
        }),
      );
      yield* waitUntilGone(
        `AGC association ${output.associationName}`,
        getAssociation(
          subscriptionId,
          output.resourceGroup,
          output.trafficController,
          output.associationName,
        ),
        ASSOCIATION_BUDGET,
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.ServiceNetworking.TrafficController",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
