import * as imagebuilder from "@distilled.cloud/azure/imagebuilder";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

export interface TriggerProps {
  /**
   * Resource group of the parent image template. Changing it replaces the
   * trigger.
   */
  resourceGroup: string;
  /** Name of the parent image template. Changing it replaces the trigger. */
  imageTemplate: string;
  /**
   * Name of the trigger. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the trigger.
   */
  name?: string;
  /**
   * Kind of trigger. `SourceImage` starts a build whenever a new version of
   * the template's `SharedImageVersion` source (referenced as
   * `.../versions/latest`) is published. Changing it replaces the trigger.
   * @default "SourceImage"
   */
  kind?: "SourceImage";
}

export interface Trigger extends Resource<
  "Azure.ImageBuilder.Trigger",
  TriggerProps,
  {
    /** Name of the trigger. */
    triggerName: string;
    /** Name of the parent image template. */
    imageTemplate: string;
    /** Resource group of the parent image template. */
    resourceGroup: string;
    /** ARM resource ID of the trigger. */
    triggerId: string;
    /** Kind of trigger. */
    kind: string;
    /** Provisioning state of the trigger. */
    provisioningState: string;
    /** Trigger status code, e.g. `Healthy`. */
    statusCode: string | undefined;
    /** Trigger status message. */
    statusMessage: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A trigger on an Azure VM Image Builder template that starts a build
 * automatically. The `SourceImage` kind rebuilds whenever a new version
 * of the template's Azure Compute Gallery source image is published, which
 * requires the template source to be a `SharedImageVersion` pointing at
 * `.../versions/latest`.
 *
 * @see https://learn.microsoft.com/azure/virtual-machines/image-builder-triggers-how-to
 *
 * ### Rebuilding on New Source Versions
 * **Example:** Trigger on the gallery image's latest version
 * ```typescript
 * const template = yield* Azure.ImageBuilder.ImageTemplate("app", {
 *   resourceGroup: group.resourceGroupName,
 *   identityId: identity.identityId,
 *   source: {
 *     type: "SharedImageVersion",
 *     imageVersionId: `${baseImageDefinitionId}/versions/latest`,
 *   },
 *   distribute,
 * });
 * yield* Azure.ImageBuilder.Trigger("on-base-update", {
 *   resourceGroup: group.resourceGroupName,
 *   imageTemplate: template.imageTemplateName,
 * });
 * ```
 *
 * @resource
 */
export const Trigger = Resource<Trigger>("Azure.ImageBuilder.Trigger");

type Observed = imagebuilder.GetTriggerResponse;

const sameId = (a: string | undefined, b: string | undefined) =>
  (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

const triggerName = (id: string) => createPhysicalName({ id, maxLength: 64 });

const getTrigger = (
  subscriptionId: string,
  resourceGroupName: string,
  imageTemplateName: string,
  triggerName: string,
) =>
  orUndefinedIfNotFound(
    imagebuilder.GetTrigger({
      subscriptionId,
      resourceGroupName,
      imageTemplateName,
      triggerName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  imageTemplate: string,
  name: string,
  observed: Observed,
): Trigger["Attributes"] => ({
  triggerName: name,
  imageTemplate,
  resourceGroup,
  triggerId: observed.id ?? "",
  kind: observed.properties?.kind ?? "SourceImage",
  provisioningState: observed.properties?.provisioningState ?? "Succeeded",
  statusCode: observed.properties?.status?.code,
  statusMessage: observed.properties?.status?.message,
});

export const TriggerProvider = () =>
  Provider.succeed(Trigger, {
    stables: ["triggerName", "imageTemplate", "resourceGroup", "triggerId"],

    // Triggers are deleted with their image template.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.resourceGroup, output.resourceGroup) ||
        !sameId(news.imageTemplate, output.imageTemplate) ||
        (news.name !== undefined && !sameId(news.name, output.triggerName)) ||
        (news.kind ?? "SourceImage") !== output.kind
      ) {
        // A template allows only one SourceImage trigger.
        return { action: "replace", deleteFirst: true } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const imageTemplate = output?.imageTemplate ?? olds?.imageTemplate;
      if (resourceGroup === undefined || imageTemplate === undefined) {
        return undefined;
      }
      const name = output?.triggerName ?? olds?.name ?? (yield* triggerName(id));
      const observed = yield* getTrigger(
        subscriptionId,
        resourceGroup,
        imageTemplate,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, imageTemplate, name, observed);
      // Triggers carry no tags; ownership follows the parent template.
      const parent = yield* orUndefinedIfNotFound(
        imagebuilder.GetVirtualMachineImageTemplate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          imageTemplateName: imageTemplate,
        }),
      );
      return hasAnyAlchemyTag(parent?.tags) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.VirtualMachineImages");
      const resourceGroup = news.resourceGroup;
      const imageTemplate = news.imageTemplate;
      const name = news.name ?? output?.triggerName ?? (yield* triggerName(id));
      const kind = news.kind ?? "SourceImage";
      const get = getTrigger(subscriptionId, resourceGroup, imageTemplate, name);

      // Observe.
      let observed = yield* get;

      // Ensure. A trigger has no mutable aspect beyond its kind.
      if (observed === undefined || observed.properties?.kind !== kind) {
        yield* imagebuilder.TriggersCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          imageTemplateName: imageTemplate,
          triggerName: name,
          properties: { kind },
        });
        observed = yield* waitForProvisioned(
          `image builder trigger ${name}`,
          get,
          (t) => t.properties?.provisioningState,
          { interval: "5 seconds", times: 60 },
        );
      }

      return toAttrs(resourceGroup, imageTemplate, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        imagebuilder.DeleteTrigger({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          imageTemplateName: output.imageTemplate,
          triggerName: output.triggerName,
        }),
      );
      yield* waitUntilGone(
        `image builder trigger ${output.triggerName}`,
        getTrigger(
          subscriptionId,
          output.resourceGroup,
          output.imageTemplate,
          output.triggerName,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceGroup",
        "Azure.ImageBuilder.ImageTemplate",
      ],
    },
  });
