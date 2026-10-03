import * as fabric from "@distilled.cloud/azure/fabric";
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

/** Fabric capacity SKU, `F2` (2 capacity units) up to `F2048`. */
export type CapacitySkuName =
  | "F2"
  | "F4"
  | "F8"
  | "F16"
  | "F32"
  | "F64"
  | "F128"
  | "F256"
  | "F512"
  | "F1024"
  | "F2048";

export interface CapacityProps {
  /**
   * Resource group the capacity is created in. Changing it replaces the
   * capacity.
   */
  resourceGroup: string;
  /**
   * Name of the capacity, 3-63 lowercase letters and digits starting with a
   * letter (no hyphens), unique per region. If omitted, a unique name is
   * generated from the app, stage, and logical ID. Changing it replaces the
   * capacity.
   */
  name?: string;
  /**
   * Azure location of the capacity. Changing it replaces the capacity.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Capacity SKU. Scaling up or down is an in-place update.
   * @default "F2"
   */
  sku?: CapacitySkuName | (string & {});
  /**
   * Capacity administrators: Microsoft Entra user principal names
   * (`admin@contoso.com`) or service principal object IDs. At least one is
   * required.
   */
  administrators: string[];
  /**
   * Desired run state. `Paused` suspends the capacity (compute billing
   * stops); `Active` resumes it. When omitted, the run state is not
   * managed and a new capacity starts `Active`.
   */
  state?: "Active" | "Paused";
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Capacity extends Resource<
  "Azure.Fabric.Capacity",
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
    /** SKU name, e.g. `F2`. */
    sku: string;
    /** Capacity administrators as Azure reports them. */
    administrators: string[];
    /** Run state, e.g. `Active` or `Paused`. */
    state: string;
    /** ARM provisioning state. */
    provisioningState: string;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A Microsoft Fabric capacity — the pool of compute (capacity units) that
 * backs Fabric and Power BI workspaces. Billing is per second while the
 * capacity is `Active`; pause it to stop compute charges.
 *
 * @see https://learn.microsoft.com/fabric/enterprise/buy-subscription
 *
 * ### Creating a Capacity
 * **Example:** F2 capacity with one administrator
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("analytics");
 * const capacity = yield* Azure.Fabric.Capacity("fabric", {
 *   resourceGroup: group.resourceGroupName,
 *   administrators: ["admin@contoso.com"],
 * });
 * ```
 *
 * **Example:** Larger SKU administered by a managed identity
 * ```typescript
 * const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity("ops", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const capacity = yield* Azure.Fabric.Capacity("fabric", {
 *   resourceGroup: group.resourceGroupName,
 *   sku: "F8",
 *   administrators: [identity.principalId],
 * });
 * ```
 *
 * ### Pausing a Capacity
 * **Example:** Suspend compute billing while keeping the capacity
 * ```typescript
 * const capacity = yield* Azure.Fabric.Capacity("fabric", {
 *   resourceGroup: group.resourceGroupName,
 *   administrators: ["admin@contoso.com"],
 *   state: "Paused",
 * });
 * ```
 *
 * @resource
 */
export const Capacity = Resource<Capacity>("Azure.Fabric.Capacity");

type ObservedCapacity = fabric.GetFabricCapacityResponse;

const PAUSED_STATES = new Set(["Paused", "Suspended"]);
const STABLE_STATES = new Set(["Active", "Paused", "Suspended", "Failed"]);

const createCapacityName = Effect.fn(function* (id: string) {
  const name = (yield* createPhysicalName({
    id,
    maxLength: 63,
    lowercase: true,
    delimiter: "",
  })).replace(/[^a-z0-9]/g, "");
  return /^[a-z]/.test(name) ? name : `f${name}`.slice(0, 63);
});

const getCapacity = (
  subscriptionId: string,
  resourceGroupName: string,
  capacityName: string,
) =>
  orUndefinedIfNotFound(
    fabric.GetFabricCapacity({
      subscriptionId,
      resourceGroupName,
      capacityName,
    }),
  );

/** Wait until provisioning succeeded and the run state is not transitional. */
const waitSettled = (
  subscriptionId: string,
  resourceGroupName: string,
  capacityName: string,
) =>
  waitForProvisioned(
    `Fabric capacity ${capacityName}`,
    getCapacity(subscriptionId, resourceGroupName, capacityName),
    (capacity) => {
      const provisioning = capacity.properties.provisioningState;
      if (provisioning !== undefined && provisioning !== "Succeeded") {
        return provisioning;
      }
      const state = capacity.properties.state;
      return state === undefined || STABLE_STATES.has(state)
        ? "Succeeded"
        : state;
    },
    { interval: "5 seconds", times: 60 },
  );

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
  administrators: [...(capacity.properties.administration?.members ?? [])],
  state: capacity.properties.state ?? "",
  provisioningState: capacity.properties.provisioningState ?? "",
  tags: userTags(capacity.tags),
});

const sameMembers = (a: readonly string[], b: readonly string[]) => {
  const norm = (xs: readonly string[]) =>
    xs.map((x) => x.toLowerCase()).sort();
  const x = norm(a);
  const y = norm(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

export const CapacityProvider = () =>
  Provider.succeed(Capacity, {
    stables: ["capacityName", "capacityId", "resourceGroup", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* fabric
        .ListFabricCapacityBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListFabricCapacityBySubscription", page),
          ),
          // An unregistered subscription cannot hold capacities.
          Effect.catchTag("MissingRegistration", () =>
            Effect.succeed({ value: [] as fabric.FabricCapacity[] }),
          ),
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
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.capacityName.toLowerCase()) ||
        (news.location !== undefined &&
          news.location.replace(/\s/g, "").toLowerCase() !==
            output.location.replace(/\s/g, "").toLowerCase())
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (typeof resourceGroup !== "string") return undefined;
      const name =
        output?.capacityName ??
        (typeof olds?.name === "string"
          ? olds.name
          : yield* createCapacityName(id));
      const observed = yield* getCapacity(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Fabric");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.capacityName ?? (yield* createCapacityName(id));
      const location = news.location ?? output?.location ?? env.location;
      const sku = news.sku ?? "F2";
      const administrators = [...news.administrators];
      const tags = yield* desiredTags(id, news.tags);
      const ref = { subscriptionId, resourceGroupName: resourceGroup, capacityName: name };
      const settle = waitSettled(subscriptionId, resourceGroup, name);

      // Observe.
      let observed = yield* getCapacity(subscriptionId, resourceGroup, name);

      // Ensure.
      if (observed === undefined) {
        yield* fabric.FabricCapacitiesCreateOrUpdate({
          ...ref,
          location,
          tags,
          sku: { name: sku, tier: "Fabric" },
          properties: { administration: { members: administrators } },
        });
      }
      observed = yield* settle;

      // A paused capacity is resumed before it is updated.
      if (
        news.state === "Active" &&
        PAUSED_STATES.has(observed.properties.state ?? "")
      ) {
        yield* fabric.ResumeFabricCapacity(ref);
        observed = yield* settle;
      }

      // Sync SKU, administrators, and tags against observed state.
      const skuChanged = observed.sku.name !== sku;
      const adminsChanged = !sameMembers(
        observed.properties.administration?.members ?? [],
        administrators,
      );
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (skuChanged || adminsChanged || tagsChanged) {
        yield* fabric.UpdateFabricCapacity({
          ...ref,
          ...(skuChanged ? { sku: { name: sku, tier: "Fabric" } } : {}),
          ...(adminsChanged
            ? { properties: { administration: { members: administrators } } }
            : {}),
          ...(tagsChanged ? { tags } : {}),
        });
        observed = yield* settle;
      }

      // Pause last so the updates above ran against an active capacity.
      if (
        news.state === "Paused" &&
        !PAUSED_STATES.has(observed.properties.state ?? "")
      ) {
        yield* fabric.SuspendFabricCapacity(ref);
        observed = yield* settle;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        fabric.DeleteFabricCapacity({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          capacityName: output.capacityName,
        }),
      );
      yield* waitUntilGone(
        `Fabric capacity ${output.capacityName}`,
        getCapacity(subscriptionId, output.resourceGroup, output.capacityName),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
