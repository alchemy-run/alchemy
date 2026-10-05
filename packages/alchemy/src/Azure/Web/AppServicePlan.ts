import * as web from "@distilled.cloud/azure/web";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
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
import { changedKeys, lower, sameLocation } from "./common.ts";

/** Operating system of the workers in an App Service plan. */
export type AppServicePlanOs = "linux" | "windows";

export interface AppServicePlanProps {
  /**
   * Resource group the plan is created in. Changing it replaces the plan.
   */
  resourceGroup: string;
  /**
   * Name of the plan: 1-60 letters, digits, and hyphens, unique within the
   * resource group. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the plan.
   */
  name?: string;
  /**
   * Azure location of the plan. Changing it replaces the plan.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Pricing SKU name, e.g. `F1` (Free), `B1` (Basic), `S1` (Standard),
   * `P0v3` (Premium v3), `Y1` (Consumption, Functions), `FC1` (Flex
   * Consumption, Functions), or `EP1` (Elastic Premium, Functions).
   * Scaling within dedicated SKUs is in place; moving between the
   * consumption SKUs (`Y1`, `FC1`) and dedicated SKUs replaces the plan.
   * @default "F1"
   */
  sku?: string;
  /**
   * Pricing tier of the SKU, e.g. `Free`, `Basic`, `FlexConsumption`.
   * @default derived from `sku`
   */
  tier?: string;
  /**
   * Number of workers (instances) of a dedicated plan.
   * @default Azure's default (1)
   */
  capacity?: number;
  /**
   * Operating system of the workers. Changing it replaces the plan.
   * @default "linux"
   */
  os?: AppServicePlanOs;
  /**
   * Scale each app independently instead of all apps across every worker.
   * @default Azure's default (`false`)
   */
  perSiteScaling?: boolean;
  /**
   * Maximum number of workers an Elastic Premium plan scales out to.
   * @default Azure's default
   */
  maximumElasticWorkerCount?: number;
  /**
   * Spread the workers across availability zones (Premium v2/v3 and
   * Isolated v2 only). Changing it replaces the plan.
   * @default false
   */
  zoneRedundant?: boolean;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface AppServicePlan extends Resource<
  "Azure.Web.AppServicePlan",
  AppServicePlanProps,
  {
    /** Name of the plan. */
    appServicePlanName: string;
    /** ARM resource ID of the plan; pass it as `serverFarmId` to apps. */
    appServicePlanId: string;
    /** Resource group that holds the plan. */
    resourceGroup: string;
    /** Location of the plan. */
    location: string;
    /** Resource kind reported by Azure, e.g. `linux`, `app`, `functionapp`. */
    kind: string;
    /** Operating system of the workers. */
    os: AppServicePlanOs;
    /** SKU name, e.g. `F1`. */
    sku: string;
    /** SKU tier, e.g. `Free`. */
    tier: string;
    /** Current number of workers. */
    capacity: number | undefined;
    /** Plan status, e.g. `Ready`. */
    status: string | undefined;
    /** Maximum number of workers the plan's SKU allows. */
    maximumNumberOfWorkers: number | undefined;
    /** Whether the workers are spread across availability zones. */
    zoneRedundant: boolean;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure App Service plan — the compute (workers, SKU, OS) that web
 * apps and function apps run on.
 *
 * The Free (`F1`), Consumption (`Y1`), and Flex Consumption (`FC1`) SKUs
 * cost nothing while idle; dedicated SKUs (`B1` and up) bill per worker
 * hour.
 *
 * @see https://learn.microsoft.com/azure/app-service/overview-hosting-plans
 *
 * ### Creating a Plan
 * **Example:** Free Linux plan
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("app");
 * const plan = yield* Azure.Web.AppServicePlan("plan", {
 *   resourceGroup: group.resourceGroupName,
 *   sku: "F1",
 * });
 * ```
 *
 * **Example:** Basic Windows plan with two workers
 * ```typescript
 * const plan = yield* Azure.Web.AppServicePlan("plan", {
 *   resourceGroup: group.resourceGroupName,
 *   sku: "B1",
 *   os: "windows",
 *   capacity: 2,
 * });
 * ```
 *
 * ### Functions Hosting
 * **Example:** Flex Consumption plan for function apps
 * ```typescript
 * const plan = yield* Azure.Web.AppServicePlan("functions", {
 *   resourceGroup: group.resourceGroupName,
 *   sku: "FC1",
 * });
 * ```
 *
 * @resource
 */
export const AppServicePlan = Resource<AppServicePlan>(
  "Azure.Web.AppServicePlan",
);

type ObservedPlan = web.GetAppServicePlanResponse;

const SKU_TIERS: Record<string, string> = {
  F1: "Free",
  D1: "Shared",
  B1: "Basic",
  B2: "Basic",
  B3: "Basic",
  S1: "Standard",
  S2: "Standard",
  S3: "Standard",
  Y1: "Dynamic",
  FC1: "FlexConsumption",
  EP1: "ElasticPremium",
  EP2: "ElasticPremium",
  EP3: "ElasticPremium",
};

/** Derive the SKU tier Azure expects for a SKU name. */
export const tierOf = (sku: string) => {
  const upper = sku.toUpperCase();
  if (SKU_TIERS[upper]) return SKU_TIERS[upper];
  if (/^P\d+V3$/.test(upper)) return "PremiumV3";
  if (/^P\d+MV3$/.test(upper)) return "PremiumMV3";
  if (/^P\d+V2$/.test(upper)) return "PremiumV2";
  if (/^P\d+V4$/.test(upper)) return "PremiumV4";
  if (/^I\d+V2$/.test(upper)) return "IsolatedV2";
  if (/^P\d$/.test(upper)) return "Premium";
  return undefined;
};

/** Consumption SKUs cannot be converted to or from dedicated SKUs. */
const familyOf = (sku: string) => {
  const upper = sku.toUpperCase();
  return upper === "Y1"
    ? "Dynamic"
    : upper === "FC1"
      ? "FlexConsumption"
      : upper.startsWith("EP")
        ? "ElasticPremium"
        : "Dedicated";
};

const kindOf = (sku: string, os: AppServicePlanOs) => {
  const family = familyOf(sku);
  if (family === "ElasticPremium") return "elastic";
  if (family !== "Dedicated") return "functionapp";
  return os === "linux" ? "linux" : "app";
};

const createPlanName = (id: string) =>
  createPhysicalName({ id, maxLength: 60, lowercase: true });

const getPlan = (
  subscriptionId: string,
  resourceGroupName: string,
  name: string,
) =>
  orUndefinedIfNotFound(
    web.GetAppServicePlan({ subscriptionId, resourceGroupName, name }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  plan: ObservedPlan,
): AppServicePlan["Attributes"] => ({
  appServicePlanName: name,
  appServicePlanId: plan.id ?? "",
  resourceGroup,
  location: plan.location,
  kind: plan.kind ?? "",
  os: plan.properties?.reserved ? "linux" : "windows",
  sku: plan.sku?.name ?? "",
  tier: plan.sku?.tier ?? "",
  capacity: plan.sku?.capacity,
  status: plan.properties?.status,
  maximumNumberOfWorkers: plan.properties?.maximumNumberOfWorkers,
  zoneRedundant: plan.properties?.zoneRedundant ?? false,
  tags: userTags(plan.tags),
});

/**
 * Microsoft.Web budgets plan creates per subscription; a burst of creates
 * is throttled, and the throttle window often lasts well over 10 minutes.
 * Each attempt already includes the SDK's own backoff, so spaced retries
 * cover ~25 minutes before the typed error surfaces.
 */
const whileCreateThrottled = {
  while: (e: { readonly _tag: string }) =>
    e._tag === "AppServicePlanCreateThrottled",
  schedule: Schedule.spaced("60 seconds"),
  times: 15,
} as const;

export const AppServicePlanProvider = () =>
  Provider.succeed(AppServicePlan, {
    stables: [
      "appServicePlanName",
      "appServicePlanId",
      "resourceGroup",
      "location",
      "os",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* web
        .ListAppServicePlans({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListAppServicePlans", page),
          ),
        );
      return (page.value ?? []).flatMap((plan) => {
        const group = resourceGroupOf(plan.id);
        return hasAnyAlchemyTag(plan.tags) &&
          group !== undefined &&
          plan.name !== undefined
          ? [toAttrs(group, plan.name, plan)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const sku = news.sku ?? "F1";
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.appServicePlanName)) ||
        (news.location !== undefined &&
          !sameLocation(news.location, output.location)) ||
        (news.os ?? "linux") !== output.os ||
        familyOf(sku) !== familyOf(output.sku) ||
        (news.zoneRedundant ?? false) !== output.zoneRedundant
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
        output?.appServicePlanName ?? olds?.name ?? (yield* createPlanName(id));
      const observed = yield* getPlan(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Web");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.appServicePlanName ?? (yield* createPlanName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const os = news.os ?? "linux";
      const skuName = news.sku ?? "F1";
      const sku: web.SkuDescription = {
        name: skuName,
        tier: news.tier ?? tierOf(skuName),
        capacity: news.capacity,
      };
      const properties = {
        reserved: os === "linux",
        perSiteScaling: news.perSiteScaling,
        maximumElasticWorkerCount: news.maximumElasticWorkerCount,
        zoneRedundant: news.zoneRedundant,
      };
      const where = { subscriptionId, resourceGroupName: resourceGroup, name };
      const label = `app service plan ${name}`;
      const get = getPlan(subscriptionId, resourceGroup, name);
      const put = web
        .AppServicePlansCreateOrUpdate({
          ...where,
          location,
          kind: kindOf(skuName, os),
          sku,
          tags,
          properties,
        })
        .pipe(Effect.retry(whileCreateThrottled));

      // Observe.
      let observed = yield* get;

      // Ensure. The PUT is a long-running operation; poll until provisioned.
      if (observed === undefined) {
        yield* put;
      }
      observed = yield* waitForProvisioned(
        label,
        get,
        (plan) => plan.properties?.provisioningState,
        { interval: "3 seconds", times: 60 },
      );

      // Sync the SKU, scaling, and tags against observed state. The PATCH
      // body carries neither SKU nor tags (and Microsoft.Web rejects the
      // generic tags API), so any delta re-sends the full PUT.
      const skuChanged =
        lower(observed.sku?.name) !== lower(skuName) ||
        (news.capacity !== undefined &&
          observed.sku?.capacity !== news.capacity);
      const changed = changedKeys(
        {
          perSiteScaling: properties.perSiteScaling,
          maximumElasticWorkerCount: properties.maximumElasticWorkerCount,
        },
        observed.properties,
      );
      if (
        skuChanged ||
        Object.keys(changed).length > 0 ||
        tagsDiffer(observed.tags, tags)
      ) {
        yield* put;
        observed = yield* waitForProvisioned(
          label,
          get,
          (plan) => plan.properties?.provisioningState,
          { interval: "3 seconds", times: 60 },
        );
      }
      return toAttrs(resourceGroup, name, observed);
    }),
    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        web.DeleteAppServicePlan({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          name: output.appServicePlanName,
        }),
      );
      yield* waitUntilGone(
        `app service plan ${output.appServicePlanName}`,
        getPlan(
          subscriptionId,
          output.resourceGroup,
          output.appServicePlanName,
        ),
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceGroup",
        "Azure.Web.AppServiceEnvironment",
      ],
    },
  });
