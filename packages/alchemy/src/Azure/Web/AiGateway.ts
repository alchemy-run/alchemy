import * as web from "@distilled.cloud/azure/web";
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
import { lower, sameLocation } from "./common.ts";

export interface AiGatewayProps {
  /** Resource group the gateway is created in. Changing it replaces it. */
  resourceGroup: string;
  /**
   * Name of the gateway. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the gateway.
   */
  name?: string;
  /**
   * Azure location of the gateway. Changing it replaces the gateway.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface AiGateway extends Resource<
  "Azure.Web.AiGateway",
  AiGatewayProps,
  {
    /** Name of the gateway. */
    aiGatewayName: string;
    /** ARM resource ID of the gateway. */
    aiGatewayResourceId: string;
    /** Service-assigned gateway ID. */
    aiGatewayId: string | undefined;
    /** Resource group that holds the gateway. */
    resourceGroup: string;
    /** Location of the gateway. */
    location: string;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An App Service AI gateway (`Microsoft.Web/aigateways`, API version
 * `2026-07-15`).
 *
 * The resource has no configurable properties yet: it is created with a
 * name, location, and tags, and reports a service-assigned gateway ID.
 *
 * ### Creating a Gateway
 * **Example:** AI gateway with tags
 * ```typescript
 * const gateway = yield* Azure.Web.AiGateway("gateway", {
 *   resourceGroup: group.resourceGroupName,
 *   tags: { team: "ai" },
 * });
 * ```
 *
 * @resource
 */
export const AiGateway = Resource<AiGateway>("Azure.Web.AiGateway");

const createGatewayName = (id: string) =>
  createPhysicalName({ id, maxLength: 60, lowercase: true });

type ObservedGateway = web.GetAiGatewayResponse;

// Until `Microsoft.Web/aigateways` is rolled out to a subscription, ARM
// rejects the type itself (`InvalidResourceType`): no gateway can exist.
const getGateway = (
  subscriptionId: string,
  resourceGroupName: string,
  name: string,
) =>
  orUndefinedIfNotFound(
    web.GetAiGateway({ subscriptionId, resourceGroupName, name }),
  ).pipe(
    Effect.catchTag("InvalidResourceType", () => Effect.succeed(undefined)),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: ObservedGateway,
) => ({
  aiGatewayName: name,
  aiGatewayResourceId: observed.id ?? "",
  aiGatewayId: observed.properties?.aiGatewayId,
  resourceGroup,
  location: observed.location,
  tags: userTags(observed.tags),
});

export const AiGatewayProvider = () =>
  Provider.succeed(AiGateway, {
    stables: [
      "aiGatewayName",
      "aiGatewayResourceId",
      "aiGatewayId",
      "resourceGroup",
      "location",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* web
        .ListAiGatewayBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListAiGatewayBySubscription", page),
          ),
          Effect.catchTag("InvalidResourceType", () =>
            Effect.succeed({ value: [] as web.AiGatewayListResult["value"] }),
          ),
        );
      return (page.value ?? []).flatMap((gateway) => {
        const group = resourceGroupOf(gateway.id);
        return hasAnyAlchemyTag(gateway.tags) &&
          group !== undefined &&
          gateway.name !== undefined
          ? [toAttrs(group, gateway.name, gateway)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.aiGatewayName)) ||
        (news.location !== undefined &&
          !sameLocation(news.location, output.location))
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
        output?.aiGatewayName ?? olds?.name ?? (yield* createGatewayName(id));
      const observed = yield* getGateway(subscriptionId, resourceGroup, name);
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
        news.name ?? output?.aiGatewayName ?? (yield* createGatewayName(id));
      const tags = yield* desiredTags(id, news.tags);
      const where = { subscriptionId, resourceGroupName: resourceGroup, name };
      const get = getGateway(subscriptionId, resourceGroup, name);

      // Observe.
      let observed = yield* get;

      // Ensure. Creation may be long-running; the gateway is usable once
      // it is readable.
      if (observed === undefined) {
        yield* web.AiGatewaysCreateOrUpdate({
          ...where,
          location: news.location ?? output?.location ?? env.location,
          tags,
          properties: {},
        });
        observed = yield* waitForProvisioned(
          `AI gateway ${name}`,
          get,
          () => undefined,
          { interval: "3 seconds", times: 40 },
        );
      }

      // Sync tags against the observed tags.
      if (tagsDiffer(observed.tags, tags)) {
        yield* web.PatchAiGateway({ ...where, tags });
        observed = (yield* get) ?? observed;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        web.DeleteAiGateway({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          name: output.aiGatewayName,
        }),
      ).pipe(Effect.catchTag("InvalidResourceType", () => Effect.void));
      yield* waitUntilGone(
        `AI gateway ${output.aiGatewayName}`,
        getGateway(subscriptionId, output.resourceGroup, output.aiGatewayName),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
