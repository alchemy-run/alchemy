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
  createAgcName,
  getTrafficController,
  sameArm,
} from "./Common.ts";

export interface TrafficControllerSecurityPolicyConfigurations {
  /**
   * ARM ID of a `waf` security policy of this traffic controller applied
   * to all its frontends.
   */
  wafSecurityPolicyId?: string;
  /**
   * ARM ID of an `ipAccessRules` security policy of this traffic
   * controller applied to all its frontends.
   */
  ipAccessRulesSecurityPolicyId?: string;
}

export interface TrafficControllerProps {
  /**
   * Resource group the traffic controller is created in. Changing it
   * replaces the traffic controller.
   */
  resourceGroup: string;
  /**
   * Traffic controller name: up to 64 letters, digits, `-`, `_`, and `.`.
   * If omitted, a unique name is generated from the app, stage, and
   * logical ID. Changing it replaces the traffic controller.
   */
  name?: string;
  /**
   * Azure location of the traffic controller. Must be a region that
   * supports Application Gateway for Containers. Changing it replaces the
   * traffic controller.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Security policies applied to every frontend of the traffic controller.
   * The policies are children of this traffic controller, so set this on
   * a later deploy than the one that creates the policy.
   */
  securityPolicyConfigurations?: TrafficControllerSecurityPolicyConfigurations;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface TrafficController extends Resource<
  "Azure.ServiceNetworking.TrafficController",
  TrafficControllerProps,
  {
    /** Name of the traffic controller. */
    trafficControllerName: string;
    /**
     * ARM resource ID of the traffic controller; the ALB controller in
     * your AKS cluster references it.
     */
    trafficControllerId: string;
    /** Resource group that holds the traffic controller. */
    resourceGroup: string;
    /** Location of the traffic controller. */
    location: string;
    /** Configuration endpoints the ALB controller talks to. */
    configurationEndpoints: string[];
    /** Observed security policy configurations. */
    securityPolicyConfigurations: TrafficControllerSecurityPolicyConfigurations;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Application Gateway for Containers traffic controller — the parent
 * resource that frontends, associations, and security policies hang off.
 * The ALB controller running in an AKS cluster programs it with routing
 * configuration from Gateway API / Ingress resources.
 *
 * A traffic controller bills hourly (about $0.017/hour) and provisions in a
 * few minutes.
 *
 * @see https://learn.microsoft.com/azure/application-gateway/for-containers/overview
 *
 * ### Creating a Traffic Controller
 * **Example:** Traffic controller in a resource group
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("agc");
 * const controller = yield* Azure.ServiceNetworking.TrafficController("alb", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * // configure the ALB controller with controller.trafficControllerId
 * ```
 *
 * ### Applying a Security Policy
 * **Example:** IP access rules applied to every frontend
 * ```typescript
 * const controller = yield* Azure.ServiceNetworking.TrafficController("alb", {
 *   resourceGroup: group.resourceGroupName,
 *   securityPolicyConfigurations: {
 *     ipAccessRulesSecurityPolicyId: policy.securityPolicyId,
 *   },
 * });
 * ```
 *
 * @resource
 */
export const TrafficController = Resource<TrafficController>(
  "Azure.ServiceNetworking.TrafficController",
);

type Observed =
  | servicenetworking.GetTrafficControllerInterfaceResponse
  | servicenetworking.TrafficController;

const toPolicyConfigs = (
  configs: servicenetworking.SecurityPolicyConfigurations | undefined,
): TrafficControllerSecurityPolicyConfigurations => ({
  wafSecurityPolicyId: configs?.wafSecurityPolicy?.id,
  ipAccessRulesSecurityPolicyId: configs?.ipAccessRulesSecurityPolicy?.id,
});

const toAttrs = (
  resourceGroup: string,
  name: string,
  controller: Observed,
): TrafficController["Attributes"] => ({
  trafficControllerName: name,
  trafficControllerId: controller.id ?? "",
  resourceGroup,
  location: controller.location,
  configurationEndpoints: [
    ...(controller.properties?.configurationEndpoints ?? []),
  ],
  securityPolicyConfigurations: toPolicyConfigs(
    controller.properties?.securityPolicyConfigurations,
  ),
  tags: userTags(controller.tags),
});

/** Whether the observed policy configurations already match the desired ones. */
const samePolicyConfigs = (
  desired: TrafficControllerSecurityPolicyConfigurations,
  observed: TrafficControllerSecurityPolicyConfigurations,
) =>
  sameArm(desired.wafSecurityPolicyId, observed.wafSecurityPolicyId) &&
  sameArm(
    desired.ipAccessRulesSecurityPolicyId,
    observed.ipAccessRulesSecurityPolicyId,
  );

export const TrafficControllerProvider = () =>
  Provider.succeed(TrafficController, {
    stables: [
      "trafficControllerName",
      "trafficControllerId",
      "resourceGroup",
      "location",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* servicenetworking
        .ListTrafficControllerInterfaceBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage(
              "ListTrafficControllerInterfaceBySubscription",
              page,
            ),
          ),
        );
      return (page.value ?? []).flatMap((controller) => {
        const group = resourceGroupOf(controller.id);
        return hasAnyAlchemyTag(controller.tags) &&
          group !== undefined &&
          controller.name !== undefined
          ? [toAttrs(group, controller.name, controller)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined &&
          !sameArm(news.name, output.trafficControllerName)) ||
        (news.location !== undefined &&
          !sameArm(news.location, output.location))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.trafficControllerName ??
        olds?.name ??
        (yield* createAgcName(id));
      const observed = yield* getTrafficController(
        subscriptionId,
        resourceGroup,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.ServiceNetworking");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ??
        output?.trafficControllerName ??
        (yield* createAgcName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const desiredPolicies = news.securityPolicyConfigurations ?? {};
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        trafficControllerName: name,
      };
      const get = getTrafficController(subscriptionId, resourceGroup, name);
      const label = `traffic controller ${name}`;
      const toPolicyInput = (
        configs: TrafficControllerSecurityPolicyConfigurations,
      ) => ({
        wafSecurityPolicy:
          configs.wafSecurityPolicyId === undefined
            ? undefined
            : { id: configs.wafSecurityPolicyId },
        ipAccessRulesSecurityPolicy:
          configs.ipAccessRulesSecurityPolicyId === undefined
            ? undefined
            : { id: configs.ipAccessRulesSecurityPolicyId },
      });

      // Observe.
      let observed = yield* get;

      // Ensure (long-running PUT).
      if (observed === undefined) {
        yield* servicenetworking.TrafficControllerInterfaceCreateOrUpdate({
          ...where,
          location,
          tags,
          properties:
            news.securityPolicyConfigurations === undefined
              ? undefined
              : {
                  securityPolicyConfigurations: toPolicyInput(desiredPolicies),
                },
        });
      }
      observed = yield* waitForProvisioned(
        label,
        get,
        (controller) => controller.properties?.provisioningState,
        AGC_BUDGET,
      );

      // Sync tags and security policy configurations against observed state.
      const tagsChanged = tagsDiffer(observed.tags, tags);
      const policiesChanged =
        news.securityPolicyConfigurations !== undefined &&
        !samePolicyConfigs(
          desiredPolicies,
          toPolicyConfigs(observed.properties?.securityPolicyConfigurations),
        );
      if (tagsChanged || policiesChanged) {
        yield* servicenetworking.UpdateTrafficControllerInterface({
          ...where,
          tags: tagsChanged ? tags : undefined,
          properties: policiesChanged
            ? { securityPolicyConfigurations: toPolicyInput(desiredPolicies) }
            : undefined,
        });
        observed = yield* waitForProvisioned(
          label,
          get,
          (controller) =>
            tagsDiffer(controller.tags, tags)
              ? "Updating"
              : controller.properties?.provisioningState,
          AGC_BUDGET,
        );
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        servicenetworking.DeleteTrafficControllerInterface({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          trafficControllerName: output.trafficControllerName,
        }),
      );
      yield* waitUntilGone(
        `traffic controller ${output.trafficControllerName}`,
        getTrafficController(
          subscriptionId,
          output.resourceGroup,
          output.trafficControllerName,
        ),
        AGC_BUDGET,
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
