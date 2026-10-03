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
import { AGC_BUDGET, childLocation, createAgcName, sameArm } from "./Common.ts";

export interface FrontendSecurityPolicyConfigurations {
  /** ARM ID of a `waf` security policy of the same traffic controller. */
  wafSecurityPolicyId?: string;
  /**
   * ARM ID of an `ipAccessRules` security policy of the same traffic
   * controller.
   */
  ipAccessRulesSecurityPolicyId?: string;
}

export interface FrontendProps {
  /**
   * Resource group of the traffic controller. Changing it replaces the
   * frontend.
   */
  resourceGroup: string;
  /**
   * Name of the traffic controller that owns the frontend. Changing it
   * replaces the frontend.
   */
  trafficController: string;
  /**
   * Frontend name: up to 64 letters, digits, `-`, `_`, and `.`. If omitted,
   * a unique name is generated from the app, stage, and logical ID.
   * Changing it replaces the frontend.
   */
  name?: string;
  /**
   * Azure location of the frontend; must match the traffic controller's
   * location. Changing it replaces the frontend.
   * @default the traffic controller's location
   */
  location?: string;
  /**
   * `Enabled` for a public frontend with a `*.alb.azure.com` FQDN,
   * `Disabled` for a private frontend in the subnet of `associationId`.
   * @default Azure's default (`Enabled`)
   */
  publicNetworkAccess?: "Enabled" | "Disabled";
  /**
   * ARM ID of the association whose subnet hosts a private frontend
   * (required when `publicNetworkAccess` is `Disabled`).
   */
  associationId?: string;
  /** Security policies applied to traffic of this frontend. */
  securityPolicyConfigurations?: FrontendSecurityPolicyConfigurations;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Frontend extends Resource<
  "Azure.ServiceNetworking.Frontend",
  FrontendProps,
  {
    /** Name of the frontend. */
    frontendName: string;
    /**
     * ARM resource ID of the frontend; Gateway API / Ingress resources in
     * AKS reference it.
     */
    frontendId: string;
    /** Name of the traffic controller that owns the frontend. */
    trafficController: string;
    /** Resource group of the traffic controller. */
    resourceGroup: string;
    /** Location of the frontend. */
    location: string;
    /**
     * Fully qualified domain name the frontend serves on, e.g.
     * `abc123.fz12.alb.azure.com`.
     */
    fqdn: string | undefined;
    /** Observed public network access (`Enabled` or `Disabled`). */
    publicNetworkAccess: string | undefined;
    /** ARM ID of the association of a private frontend. */
    associationId: string | undefined;
    /** Observed security policy configurations. */
    securityPolicyConfigurations: FrontendSecurityPolicyConfigurations;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A frontend of an Application Gateway for Containers traffic controller —
 * the entry point (an `*.alb.azure.com` FQDN, or a private IP in an
 * association's subnet) that client traffic arrives on.
 *
 * Frontends bill hourly (about $0.01/hour) and provision in a few minutes.
 *
 * @see https://learn.microsoft.com/azure/application-gateway/for-containers/application-gateway-for-containers-components
 *
 * ### Creating a Frontend
 * **Example:** Public frontend
 * ```typescript
 * const frontend = yield* Azure.ServiceNetworking.Frontend("web", {
 *   resourceGroup: group.resourceGroupName,
 *   trafficController: controller.trafficControllerName,
 * });
 * // point a CNAME at frontend.fqdn
 * ```
 *
 * ### Securing a Frontend
 * **Example:** Frontend with IP access rules
 * ```typescript
 * const frontend = yield* Azure.ServiceNetworking.Frontend("web", {
 *   resourceGroup: group.resourceGroupName,
 *   trafficController: controller.trafficControllerName,
 *   securityPolicyConfigurations: {
 *     ipAccessRulesSecurityPolicyId: policy.securityPolicyId,
 *   },
 * });
 * ```
 *
 * @resource
 */
export const Frontend = Resource<Frontend>("Azure.ServiceNetworking.Frontend");

type Observed =
  | servicenetworking.GetFrontendsInterfaceResponse
  | servicenetworking.Frontend;

const getFrontend = (
  subscriptionId: string,
  resourceGroupName: string,
  trafficControllerName: string,
  frontendName: string,
) =>
  orUndefinedIfNotFound(
    servicenetworking.GetFrontendsInterface({
      subscriptionId,
      resourceGroupName,
      trafficControllerName,
      frontendName,
    }),
  );

const toPolicyConfigs = (
  configs: servicenetworking.SecurityPolicyConfigurations | undefined,
): FrontendSecurityPolicyConfigurations => ({
  wafSecurityPolicyId: configs?.wafSecurityPolicy?.id,
  ipAccessRulesSecurityPolicyId: configs?.ipAccessRulesSecurityPolicy?.id,
});

const toPolicyInput = (configs: FrontendSecurityPolicyConfigurations) => ({
  wafSecurityPolicy:
    configs.wafSecurityPolicyId === undefined
      ? undefined
      : { id: configs.wafSecurityPolicyId },
  ipAccessRulesSecurityPolicy:
    configs.ipAccessRulesSecurityPolicyId === undefined
      ? undefined
      : { id: configs.ipAccessRulesSecurityPolicyId },
});

const toAttrs = (
  resourceGroup: string,
  trafficController: string,
  name: string,
  frontend: Observed,
): Frontend["Attributes"] => ({
  frontendName: name,
  frontendId: frontend.id ?? "",
  trafficController,
  resourceGroup,
  location: frontend.location,
  fqdn: frontend.properties?.fqdn,
  publicNetworkAccess: frontend.properties?.publicNetworkAccess,
  associationId: frontend.properties?.association?.id,
  securityPolicyConfigurations: toPolicyConfigs(
    frontend.properties?.securityPolicyConfigurations,
  ),
  tags: userTags(frontend.tags),
});

export const FrontendProvider = () =>
  Provider.succeed(Frontend, {
    stables: [
      "frontendName",
      "frontendId",
      "trafficController",
      "resourceGroup",
      "location",
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
      const found: Frontend["Attributes"][] = [];
      for (const controller of controllers.value ?? []) {
        const group = resourceGroupOf(controller.id);
        if (group === undefined || controller.name === undefined) continue;
        const page = yield* orUndefinedIfNotFound(
          servicenetworking.ListFrontendsInterfaceByTrafficController({
            subscriptionId,
            resourceGroupName: group,
            trafficControllerName: controller.name,
          }),
        );
        if (page !== undefined) {
          yield* requireSinglePage(
            "ListFrontendsInterfaceByTrafficController",
            page,
          );
        }
        for (const frontend of page?.value ?? []) {
          if (hasAnyAlchemyTag(frontend.tags) && frontend.name !== undefined) {
            found.push(
              toAttrs(group, controller.name, frontend.name, frontend),
            );
          }
        }
      }
      return found;
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        !sameArm(news.trafficController, output.trafficController) ||
        (news.name !== undefined && !sameArm(news.name, output.frontendName)) ||
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
      const trafficController =
        output?.trafficController ?? olds?.trafficController;
      if (resourceGroup === undefined || trafficController === undefined) {
        return undefined;
      }
      const name =
        output?.frontendName ?? olds?.name ?? (yield* createAgcName(id));
      const observed = yield* getFrontend(
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
        news.name ?? output?.frontendName ?? (yield* createAgcName(id));
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        trafficControllerName: trafficController,
        frontendName: name,
      };
      const get = getFrontend(
        subscriptionId,
        resourceGroup,
        trafficController,
        name,
      );
      const label = `AGC frontend ${name}`;

      // Observe.
      let observed = yield* get;

      // Ensure (long-running PUT). Children live in the parent's location.
      if (observed === undefined) {
        const location = yield* childLocation(
          subscriptionId,
          resourceGroup,
          trafficController,
          news.location ?? output?.location,
          env.location,
        );
        yield* servicenetworking.FrontendsInterfaceCreateOrUpdate({
          ...where,
          location,
          tags,
          properties: {
            publicNetworkAccess: news.publicNetworkAccess,
            association:
              news.associationId === undefined
                ? undefined
                : { id: news.associationId },
            securityPolicyConfigurations:
              news.securityPolicyConfigurations === undefined
                ? undefined
                : toPolicyInput(news.securityPolicyConfigurations),
          },
        });
      }
      observed = yield* waitForProvisioned(
        label,
        get,
        (frontend) => frontend.properties?.provisioningState,
        AGC_BUDGET,
      );

      // Sync each mutable aspect against observed state; PATCH only deltas.
      const current = toAttrs(resourceGroup, trafficController, name, observed);
      const changed: servicenetworking.FrontendUpdateProperties = {};
      if (
        news.publicNetworkAccess !== undefined &&
        !sameArm(news.publicNetworkAccess, current.publicNetworkAccess)
      ) {
        changed.publicNetworkAccess = news.publicNetworkAccess;
      }
      if (
        news.associationId !== undefined &&
        !sameArm(news.associationId, current.associationId)
      ) {
        changed.association = { id: news.associationId };
      }
      const desiredPolicies = news.securityPolicyConfigurations;
      if (
        desiredPolicies !== undefined &&
        !(
          sameArm(
            desiredPolicies.wafSecurityPolicyId,
            current.securityPolicyConfigurations.wafSecurityPolicyId,
          ) &&
          sameArm(
            desiredPolicies.ipAccessRulesSecurityPolicyId,
            current.securityPolicyConfigurations.ipAccessRulesSecurityPolicyId,
          )
        )
      ) {
        changed.securityPolicyConfigurations = toPolicyInput(desiredPolicies);
      }
      const tagsChanged = tagsDiffer(observed.tags, tags);
      const propsChanged = Object.keys(changed).length > 0;
      if (tagsChanged || propsChanged) {
        yield* servicenetworking.UpdateFrontendsInterface({
          ...where,
          tags: tagsChanged ? tags : undefined,
          properties: propsChanged ? changed : undefined,
        });
        observed = yield* waitForProvisioned(
          label,
          get,
          (frontend) =>
            tagsDiffer(frontend.tags, tags)
              ? "Updating"
              : frontend.properties?.provisioningState,
          AGC_BUDGET,
        );
      }

      return toAttrs(resourceGroup, trafficController, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        servicenetworking.DeleteFrontendsInterface({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          trafficControllerName: output.trafficController,
          frontendName: output.frontendName,
        }),
      );
      yield* waitUntilGone(
        `AGC frontend ${output.frontendName}`,
        getFrontend(
          subscriptionId,
          output.resourceGroup,
          output.trafficController,
          output.frontendName,
        ),
        AGC_BUDGET,
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.ServiceNetworking.TrafficController",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
