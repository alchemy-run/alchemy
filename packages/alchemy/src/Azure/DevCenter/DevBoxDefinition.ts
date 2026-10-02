import * as devcenter from "@distilled.cloud/azure/devcenter";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { createDevCenterName, sameArm } from "./Common.ts";

export interface DevBoxDefinitionProps {
  /** Resource group of the dev center. Changing it replaces the definition. */
  resourceGroup: string;
  /** Name of the dev center. Changing it replaces the definition. */
  devCenter: string;
  /**
   * Definition name. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the definition.
   */
  name?: string;
  /**
   * Azure location of the definition. Changing it replaces the definition.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Image ID: a dev center gallery image, e.g.
   * `{devCenterId}/galleries/default/images/microsoftwindowsdesktop_windows-ent-cpc_win11-24h2-ent-cpc`,
   * optionally with `/versions/{version}`.
   */
  imageReferenceId: string;
  /** Dev Box SKU name, e.g. `general_i_8c32gb256ssd_v2`. */
  skuName: string;
  /** OS disk storage type, e.g. `ssd_256gb`. */
  osStorageType?: string;
  /**
   * Whether dev boxes of this definition support hibernation.
   * @default Azure's default (`Disabled`)
   */
  hibernateSupport?: "Enabled" | "Disabled";
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface DevBoxDefinition extends Resource<
  "Azure.DevCenter.DevBoxDefinition",
  DevBoxDefinitionProps,
  {
    /** Name of the definition; pools refer to it as `devBoxDefinitionName`. */
    devBoxDefinitionName: string;
    /** ARM resource ID of the definition. */
    devBoxDefinitionId: string;
    /** Name of the dev center. */
    devCenter: string;
    /** Resource group of the dev center. */
    resourceGroup: string;
    /** Location of the definition. */
    location: string;
    /** Image ID of the definition. */
    imageReferenceId: string | undefined;
    /** Dev Box SKU name. */
    skuName: string;
    /** Image validation status (`Succeeded`, `Pending`, `Failed`, ...). */
    imageValidationStatus: string | undefined;
    /** Image the definition currently resolves to. */
    activeImageReferenceId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A dev box definition — the image, compute SKU, and OS disk that dev
 * boxes of a pool are created from. Creating a definition is free; dev
 * boxes are billed per hour once developers create them.
 *
 * @see https://learn.microsoft.com/azure/dev-box/how-to-manage-dev-box-definitions
 *
 * ### Creating a Dev Box Definition
 * **Example:** Windows 11 Enterprise on 8 vCPU / 32 GB
 * ```typescript
 * const definition = yield* Azure.DevCenter.DevBoxDefinition("win11", {
 *   resourceGroup: group.resourceGroupName,
 *   devCenter: center.devCenterName,
 *   imageReferenceId: Output.interpolate`${center.devCenterId}/galleries/default/images/microsoftwindowsdesktop_windows-ent-cpc_win11-24h2-ent-cpc`,
 *   skuName: "general_i_8c32gb256ssd_v2",
 *   osStorageType: "ssd_256gb",
 *   hibernateSupport: "Enabled",
 * });
 * ```
 *
 * @resource
 */
export const DevBoxDefinition = Resource<DevBoxDefinition>(
  "Azure.DevCenter.DevBoxDefinition",
);

type Observed = devcenter.GetDevBoxDefinitionResponse;

const getDevBoxDefinition = (
  subscriptionId: string,
  resourceGroupName: string,
  devCenterName: string,
  devBoxDefinitionName: string,
) =>
  orUndefinedIfNotFound(
    devcenter.GetDevBoxDefinition({
      subscriptionId,
      resourceGroupName,
      devCenterName,
      devBoxDefinitionName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  devCenter: string,
  name: string,
  observed: Observed,
): DevBoxDefinition["Attributes"] => ({
  devBoxDefinitionName: name,
  devBoxDefinitionId: observed.id ?? "",
  devCenter,
  resourceGroup,
  location: observed.location,
  imageReferenceId: observed.properties?.imageReference?.id,
  skuName: observed.properties?.sku?.name ?? "",
  imageValidationStatus: observed.properties?.imageValidationStatus,
  activeImageReferenceId: observed.properties?.activeImageReference?.id,
  tags: userTags(observed.tags),
});

/** Deleting a definition fails with a conflict while pools still use it. */
const whileInUse = {
  while: (e: { readonly _tag: string }) => e._tag === "ResourceConflict",
  schedule: Schedule.spaced("10 seconds"),
  times: 12,
} as const;

export const DevBoxDefinitionProvider = () =>
  Provider.succeed(DevBoxDefinition, {
    stables: [
      "devBoxDefinitionName",
      "devBoxDefinitionId",
      "devCenter",
      "resourceGroup",
      "location",
    ],

    // Definitions live inside a dev center; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        !sameArm(news.devCenter, output.devCenter) ||
        (news.name !== undefined &&
          !sameArm(news.name, output.devBoxDefinitionName)) ||
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
      const devCenter = output?.devCenter ?? olds?.devCenter;
      if (resourceGroup === undefined || devCenter === undefined) {
        return undefined;
      }
      const name =
        output?.devBoxDefinitionName ??
        olds?.name ??
        (yield* createDevCenterName(id));
      const observed = yield* getDevBoxDefinition(
        subscriptionId,
        resourceGroup,
        devCenter,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, devCenter, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.DevCenter");
      const { resourceGroup, devCenter } = news;
      const name =
        news.name ??
        output?.devBoxDefinitionName ??
        (yield* createDevCenterName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        devCenterName: devCenter,
        devBoxDefinitionName: name,
      };
      const label = `dev box definition ${name}`;
      const get = getDevBoxDefinition(
        subscriptionId,
        resourceGroup,
        devCenter,
        name,
      );
      const stateOf = (observed: Observed) =>
        observed.properties?.provisioningState;

      // Observe.
      let observed = yield* get;

      // Ensure. The PUT is a long-running operation; read-only fields of
      // the input type are never sent.
      if (observed === undefined) {
        yield* devcenter.DevBoxDefinitionsCreateOrUpdate({
          ...where,
          location,
          tags,
          properties: {
            imageReference: { id: news.imageReferenceId },
            sku: { name: news.skuName },
            osStorageType: news.osStorageType,
            hibernateSupport: news.hibernateSupport,
          },
        });
      }
      observed = yield* waitForProvisioned(label, get, stateOf, {
        interval: "5 seconds",
        times: 72,
      });

      // Sync each mutable aspect against observed state; PATCH only deltas.
      const props = observed.properties;
      const changed: devcenter.DevBoxDefinitionUpdatePropertiesInput = {};
      if (!sameArm(props?.imageReference?.id, news.imageReferenceId)) {
        changed.imageReference = { id: news.imageReferenceId };
      }
      if (props?.sku?.name !== news.skuName) {
        changed.sku = { name: news.skuName };
      }
      if (
        news.osStorageType !== undefined &&
        props?.osStorageType !== news.osStorageType
      ) {
        changed.osStorageType = news.osStorageType;
      }
      if (
        news.hibernateSupport !== undefined &&
        props?.hibernateSupport !== news.hibernateSupport
      ) {
        changed.hibernateSupport = news.hibernateSupport;
      }
      const propsChanged = Object.keys(changed).length > 0;
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (propsChanged || tagsChanged) {
        yield* devcenter.UpdateDevBoxDefinition({
          ...where,
          tags: tagsChanged ? tags : undefined,
          properties: propsChanged ? changed : undefined,
        });
        observed = yield* waitForProvisioned(label, get, stateOf, {
          interval: "5 seconds",
          times: 72,
        });
      }

      return toAttrs(resourceGroup, devCenter, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        devcenter
          .DeleteDevBoxDefinition({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            devCenterName: output.devCenter,
            devBoxDefinitionName: output.devBoxDefinitionName,
          })
          .pipe(Effect.retry(whileInUse)),
      );
      yield* waitUntilGone(
        `dev box definition ${output.devBoxDefinitionName}`,
        getDevBoxDefinition(
          subscriptionId,
          output.resourceGroup,
          output.devCenter,
          output.devBoxDefinitionName,
        ),
        { interval: "5 seconds", times: 72 },
      );
    }),

    nuke: {
      dependsOn: ["Azure.DevCenter.DevCenter", "Azure.Resources.ResourceGroup"],
    },
  });
