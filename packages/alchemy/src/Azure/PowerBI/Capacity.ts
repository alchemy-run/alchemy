import * as powerbidedicated from "@distilled.cloud/azure/powerbidedicated";
import * as Effect from "effect/Effect";
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

/** Power BI Embedded capacity SKU (A1 = 1 v-core ... A8 = 32 v-cores). */
export type CapacitySkuName =
  | "A1"
  | "A2"
  | "A3"
  | "A4"
  | "A5"
  | "A6"
  | "A7"
  | "A8"
  | (string & {});

/** Power BI Embedded generation. */
export type CapacityMode = "Gen1" | "Gen2";

export interface CapacityProps {
  /**
   * Resource group the capacity is created in. Changing it replaces the
   * capacity.
   */
  resourceGroup: string;
  /**
   * Capacity name: 3-63 lowercase letters and digits, starting with a
   * letter, unique per region. If omitted, a unique name is generated from
   * the app, stage, and logical ID. Changing it replaces the capacity.
   */
  name?: string;
  /**
   * Azure location of the capacity. Changing it replaces the capacity.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Capacity SKU. Scaled in place.
   * @default "A1"
   */
  sku?: CapacitySkuName;
  /**
   * Capacity administrators: Microsoft Entra user principal names (UPNs)
   * or service principal object IDs. At least one is required.
   */
  administrators: string[];
  /**
   * Power BI Embedded generation. Changing it replaces the capacity.
   * @default "Gen2"
   */
  mode?: CapacityMode;
  /**
   * Pause the capacity. A paused capacity is not billed; resuming it
   * restores the same capacity.
   * @default false
   */
  suspended?: boolean;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Capacity extends Resource<
  "Azure.PowerBI.Capacity",
  CapacityProps,
  {
    /** Name of the capacity. */
    capacityName: string;
    /** ARM resource ID of the capacity. */
    capacityId: string;
    /** Resource group that holds the capacity. */
    resourceGroup: string;
    /** Location of the capacity. */
    location: string;
    /** Capacity SKU name, e.g. `A1`. */
    sku: string;
    /** Power BI Embedded generation (`Gen1` or `Gen2`). */
    mode: string;
    /** Capacity administrators (UPNs or service principal object IDs). */
    administrators: string[];
    /** Current capacity state, e.g. `Succeeded` or `Paused`. */
    state: string | undefined;
    /** Whether the capacity is paused. */
    suspended: boolean;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A Power BI Embedded (A-SKU) capacity — dedicated compute for embedding
 * Power BI reports in applications. Billed per hour while running; set
 * `suspended: true` to pause billing without deleting the capacity.
 *
 * @see https://learn.microsoft.com/power-bi/developer/embedded/azure-pbie-what-is-power-bi-embedded
 *
 * ### Creating a Capacity
 * **Example:** A1 capacity administered by a user
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("analytics");
 * const capacity = yield* Azure.PowerBI.Capacity("embedded", {
 *   resourceGroup: group.resourceGroupName,
 *   administrators: ["admin@contoso.com"],
 * });
 * ```
 *
 * **Example:** Capacity administered by a managed identity
 * ```typescript
 * const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity("pbi");
 * const capacity = yield* Azure.PowerBI.Capacity("embedded", {
 *   resourceGroup: group.resourceGroupName,
 *   sku: "A2",
 *   administrators: [identity.principalId],
 * });
 * ```
 *
 * ### Pausing a Capacity
 * **Example:** Suspend the capacity to stop billing
 * ```typescript
 * const capacity = yield* Azure.PowerBI.Capacity("embedded", {
 *   resourceGroup: group.resourceGroupName,
 *   administrators: ["admin@contoso.com"],
 *   suspended: true,
 * });
 * ```
 *
 * @resource
 */
export const Capacity = Resource<Capacity>("Azure.PowerBI.Capacity");

type ObservedCapacity = powerbidedicated.GetCapacityDetailsResponse;

const createCapacityName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({
    id,
    maxLength: 63,
    lowercase: true,
    delimiter: "",
  });
  const cleaned = name.replace(/[^a-z0-9]/g, "");
  return /^[a-z]/.test(cleaned) ? cleaned : `p${cleaned}`.slice(0, 63);
});

const getCapacity = (
  subscriptionId: string,
  resourceGroupName: string,
  dedicatedCapacityName: string,
) =>
  orUndefinedIfNotFound(
    powerbidedicated.GetCapacityDetails({
      subscriptionId,
      resourceGroupName,
      dedicatedCapacityName,
    }),
  );

const PAUSED = new Set(["Paused", "Suspended"]);

const isPaused = (capacity: ObservedCapacity) =>
  PAUSED.has(capacity.properties?.state ?? "");

const toAttrs = (
  resourceGroup: string,
  name: string,
  capacity: ObservedCapacity,
): Capacity["Attributes"] => ({
  capacityName: name,
  capacityId: capacity.id ?? "",
  resourceGroup,
  location: capacity.location,
  sku: capacity.sku.name,
  mode: capacity.properties?.mode ?? "Gen2",
  administrators: [...(capacity.properties?.administration?.members ?? [])],
  state: capacity.properties?.state,
  suspended: isPaused(capacity),
  tags: userTags(capacity.tags),
});

const lower = (value: string | undefined) => value?.toLowerCase();

const sameMembers = (a: readonly string[], b: readonly string[]) => {
  const left = new Set(a.map((m) => m.toLowerCase()));
  const right = new Set(b.map((m) => m.toLowerCase()));
  return left.size === right.size && [...left].every((m) => right.has(m));
};

/**
 * Readiness after a PUT/PATCH: a paused capacity reports `Paused` as both
 * its state and provisioning state, which is settled.
 */
const provisionedState = (capacity: ObservedCapacity) => {
  const state = capacity.properties?.provisioningState;
  return state !== undefined && PAUSED.has(state) ? "Succeeded" : state;
};

export const CapacityProvider = () =>
  Provider.succeed(Capacity, {
    stables: ["capacityName", "capacityId", "resourceGroup", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* powerbidedicated
        .ListCapacities({ subscriptionId })
        .pipe(
          Effect.flatMap((page) => requireSinglePage("ListCapacities", page)),
        );
      return (page.value ?? []).flatMap((capacity) => {
        const group = resourceGroupOf(capacity.id);
        return hasAnyAlchemyTag(capacity.tags) &&
          group !== undefined &&
          capacity.name !== undefined
          ? [toAttrs(group, capacity.name, capacity)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined && news.name !== output.capacityName) ||
        (news.location !== undefined &&
          lower(news.location)?.replace(/\s/g, "") !==
            lower(output.location)?.replace(/\s/g, "")) ||
        (news.mode ?? "Gen2") !== output.mode
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
        output?.capacityName ?? olds?.name ?? (yield* createCapacityName(id));
      const observed = yield* getCapacity(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.PowerBIDedicated");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.capacityName ?? (yield* createCapacityName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const sku = news.sku ?? "A1";
      const suspended = news.suspended ?? false;
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        dedicatedCapacityName: name,
      };
      const label = `Power BI capacity ${name}`;
      const get = getCapacity(subscriptionId, resourceGroup, name);
      const settle = waitForProvisioned(label, get, provisionedState, {
        interval: "5 seconds",
        times: 60,
      });
      const waitForState = (target: "paused" | "running") =>
        waitForProvisioned(
          label,
          get,
          (capacity) => {
            const state = capacity.properties?.state;
            if (state === "Failed") return state;
            return (target === "paused") === isPaused(capacity) &&
              state !== "Pausing" &&
              state !== "Suspending" &&
              state !== "Resuming"
              ? "Succeeded"
              : "Pending";
          },
          { interval: "5 seconds", times: 60 },
        );

      // Observe.
      let observed = yield* get;

      // Ensure. Creation is a long-running operation (201 + polling).
      if (observed === undefined) {
        yield* powerbidedicated.CreateCapacity({
          ...where,
          location,
          sku: { name: sku, tier: "PBIE_Azure" },
          tags,
          properties: {
            administration: { members: news.administrators },
            mode: news.mode ?? "Gen2",
          },
        });
      }
      observed = yield* settle;

      // Resume before any other change: a paused capacity cannot scale.
      if (!suspended && isPaused(observed)) {
        yield* powerbidedicated.ResumeCapacity(where);
        observed = yield* waitForState("running");
      }

      // Sync SKU, administrators, and tags against observed state.
      const skuChanged = observed.sku.name !== sku;
      const adminsChanged = !sameMembers(
        observed.properties?.administration?.members ?? [],
        news.administrators,
      );
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (skuChanged || adminsChanged || tagsChanged) {
        yield* powerbidedicated.UpdateCapacity({
          ...where,
          sku: skuChanged ? { name: sku, tier: "PBIE_Azure" } : undefined,
          tags: tagsChanged ? tags : undefined,
          properties: adminsChanged
            ? { administration: { members: news.administrators } }
            : undefined,
        });
        observed = yield* settle;
      }

      // Pause last so every other change has been applied.
      if (suspended && !isPaused(observed)) {
        yield* powerbidedicated.SuspendCapacity(where);
        observed = yield* waitForState("paused");
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        powerbidedicated.DeleteCapacity({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          dedicatedCapacityName: output.capacityName,
        }),
      );
      yield* waitUntilGone(
        `Power BI capacity ${output.capacityName}`,
        getCapacity(subscriptionId, output.resourceGroup, output.capacityName),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
