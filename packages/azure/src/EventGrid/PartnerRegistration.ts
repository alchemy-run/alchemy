import * as eventgrid from "@distilled.cloud/azure/eventgrid";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  collectAll,
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { createEventGridName, sameName } from "./common.ts";

export interface PartnerRegistrationProps {
  /**
   * Resource group the registration is created in.
   *
   * :::caution
   * Changing it replaces the registration.
   * :::
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup: string;
  /**
   * Registration name: 3-50 letters, digits, and hyphens. If omitted, a
   * unique name is generated from the app, stage, and logical ID.
   *
   * :::caution
   * Changing it replaces the registration.
   * :::
   * @default a name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   * @default {}
   */
  tags?: Record<string, string>;
}

export interface PartnerRegistration extends Resource<
  "Azure.EventGrid.PartnerRegistration",
  PartnerRegistrationProps,
  {
    /** Name of the registration. */
    partnerRegistrationName: string;
    /**
     * ARM resource ID of the registration; pass it as `partnerRegistration`
     * of an `Azure.EventGrid.PartnerNamespace`.
     */
    partnerRegistrationId: string;
    /** Resource group that holds the registration. */
    resourceGroup: string;
    /**
     * Immutable ID subscribers authorize in their
     * `Azure.EventGrid.PartnerConfiguration`.
     */
    partnerRegistrationImmutableId: string;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Event Grid partner registration (`Microsoft.EventGrid/partnerRegistrations`)
 * — the publisher side of Event Grid partner events. A SaaS provider
 * registers once, then publishes through an `Azure.EventGrid.PartnerNamespace`
 * that references the registration. Subscribers authorize the registration's
 * `partnerRegistrationImmutableId` in their `Azure.EventGrid.PartnerConfiguration`.
 *
 * :::caution[Changing `name` or `resourceGroup` replaces the registration]
 * Alchemy creates a new registration with a new
 * `partnerRegistrationImmutableId` and deletes the old one. Every subscriber
 * must authorize the new ID before your channels can create partner topics
 * for them again.
 * :::
 *
 * :::caution[A new registration is unverified]
 * Azure creates it with `visibilityState: Hidden`. It can create partner
 * topics, but subscribers cannot find it by partner name until Microsoft
 * verifies the partner. Give subscribers the
 * `partnerRegistrationImmutableId` to authorize instead.
 * :::
 *
 * @see https://learn.microsoft.com/azure/event-grid/onboard-partner
 *
 * ### Registering as a Partner
 * **Example:** Partner registration
 * ```typescript
 * const registration = yield* Azure.EventGrid.PartnerRegistration("contoso");
 * ```
 *
 * **Example:** Registration with tags
 * ```typescript
 * const registration = yield* Azure.EventGrid.PartnerRegistration("contoso", {
 *   tags: { team: "integrations" },
 * });
 * ```
 *
 * ### Publishing Partner Events
 * **Example:** Registration and the partner namespace that publishes for it
 * ```typescript
 * const registration = yield* Azure.EventGrid.PartnerRegistration("contoso");
 * const namespace = yield* Azure.EventGrid.PartnerNamespace("contoso-events", {
 *   partnerRegistration: registration.partnerRegistrationId,
 * });
 * ```
 *
 * @resource
 */
export const PartnerRegistration = GroupedResource<PartnerRegistration>(
  "Azure.EventGrid.PartnerRegistration",
);

type ObservedRegistration = Pick<eventgrid.PartnerRegistration, "id" | "properties" | "tags">;

const getRegistration = (
  subscriptionId: string,
  resourceGroupName: string,
  partnerRegistrationName: string,
) =>
  orUndefinedIfNotFound(
    eventgrid.GetPartnerRegistration({
      subscriptionId,
      resourceGroupName,
      partnerRegistrationName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: ObservedRegistration,
): PartnerRegistration["Attributes"] => ({
  partnerRegistrationName: name,
  partnerRegistrationId: observed.id ?? "",
  resourceGroup,
  partnerRegistrationImmutableId: observed.properties?.partnerRegistrationImmutableId ?? "",
  tags: userTags(observed.tags),
});

const provisioned = (registration: ObservedRegistration) =>
  registration.properties?.provisioningState;

export const PartnerRegistrationProvider = () =>
  Provider.succeed(PartnerRegistration, {
    stables: [
      "partnerRegistrationName",
      "partnerRegistrationId",
      "resourceGroup",
      "partnerRegistrationImmutableId",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* collectAll(eventgrid.ListPartnerRegistrationBySubscription, {
        subscriptionId,
      });
      return (page.value ?? []).flatMap((registration) => {
        const group = resourceGroupOf(registration.id);
        return hasAnyAlchemyTag(registration.tags) &&
          group !== undefined &&
          registration.name !== undefined
          ? [toAttrs(group, registration.name, registration)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && news.name !== output.partnerRegistrationName)
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
        output?.partnerRegistrationName ?? olds?.name ?? (yield* createEventGridName(id, 50));
      const observed = yield* getRegistration(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.EventGrid");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.partnerRegistrationName ?? (yield* createEventGridName(id, 50));
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        partnerRegistrationName: name,
      };
      const get = getRegistration(subscriptionId, resourceGroup, name);
      const label = `event grid partner registration ${name}`;

      // Observe.
      let observed = yield* get;

      // Ensure. Registrations are global.
      if (observed === undefined) {
        yield* eventgrid.PartnerRegistrationsCreateOrUpdate({
          ...where,
          location: "global",
          tags,
        });
      }
      observed = yield* waitForProvisioned(label, get, provisioned);

      // Sync. Tags are the only mutable aspect.
      if (tagsDiffer(observed.tags, tags)) {
        yield* eventgrid.UpdatePartnerRegistration({ ...where, tags });
        observed = yield* waitForProvisioned(label, get, provisioned);
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        eventgrid.DeletePartnerRegistration({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          partnerRegistrationName: output.partnerRegistrationName,
        }),
      );
      yield* waitUntilGone(
        `event grid partner registration ${output.partnerRegistrationName}`,
        getRegistration(subscriptionId, output.resourceGroup, output.partnerRegistrationName),
        { times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
