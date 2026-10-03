import * as eventgrid from "@distilled.cloud/azure/eventgrid";
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
import { sameName } from "./common.ts";

/** A SaaS partner authorized to create partner topics in the resource group. */
export interface AuthorizedPartner {
  /** Immutable ID of the partner's registration (a GUID the partner publishes). */
  partnerRegistrationImmutableId: string;
  /** Display name of the partner. */
  partnerName?: string;
  /**
   * When the authorization expires (ISO 8601). Must fall within
   * `defaultMaximumExpirationTimeInDays`.
   * @default now + `defaultMaximumExpirationTimeInDays`
   */
  authorizationExpirationTimeInUtc?: string;
}

export interface PartnerConfigurationProps {
  /**
   * Resource group the partner configuration belongs to. There is one
   * configuration (named `default`) per resource group. Changing it replaces
   * the configuration.
   */
  resourceGroup: string;
  /**
   * Maximum number of days a partner authorization may last (1-365).
   * @default 7
   */
  defaultMaximumExpirationTimeInDays?: number;
  /**
   * Partners authorized to create partner topics or destinations in the
   * resource group.
   * @default []
   */
  authorizedPartners?: AuthorizedPartner[];
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface PartnerConfiguration extends Resource<
  "Azure.EventGrid.PartnerConfiguration",
  PartnerConfigurationProps,
  {
    /** ARM resource ID of the partner configuration. */
    partnerConfigurationId: string;
    /** Resource group of the partner configuration. */
    resourceGroup: string;
    /** Maximum authorization length in days. */
    defaultMaximumExpirationTimeInDays: number | undefined;
    /** Immutable IDs of the authorized partner registrations. */
    authorizedPartnerIds: string[];
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * The Event Grid partner configuration of a resource group: the list of
 * SaaS partners (Auth0, Microsoft Graph API, SAP, …) authorized to create
 * partner topics in it. Each resource group has exactly one configuration,
 * named `default`, in the `global` location.
 *
 * @see https://learn.microsoft.com/azure/event-grid/subscribe-to-partner-events
 *
 * ### Authorizing Partners
 * **Example:** Authorize a partner for 30 days
 * ```typescript
 * const partners = yield* Azure.EventGrid.PartnerConfiguration("partners", {
 *   resourceGroup: group.resourceGroupName,
 *   defaultMaximumExpirationTimeInDays: 30,
 *   authorizedPartners: [
 *     {
 *       partnerRegistrationImmutableId: "941a5b43-6d4c-4d3c-9c9e-2c1d4b8a7f10",
 *       partnerName: "Auth0",
 *     },
 *   ],
 * });
 * ```
 *
 * **Example:** Empty configuration with a default expiry
 * ```typescript
 * const partners = yield* Azure.EventGrid.PartnerConfiguration("partners", {
 *   resourceGroup: group.resourceGroupName,
 *   defaultMaximumExpirationTimeInDays: 14,
 * });
 * ```
 *
 * @resource
 */
export const PartnerConfiguration = Resource<PartnerConfiguration>(
  "Azure.EventGrid.PartnerConfiguration",
);

type ObservedConfiguration = Pick<
  eventgrid.PartnerConfiguration,
  "id" | "properties" | "tags"
>;

const getConfiguration = (subscriptionId: string, resourceGroupName: string) =>
  orUndefinedIfNotFound(
    eventgrid.GetPartnerConfiguration({ subscriptionId, resourceGroupName }),
  );

const toAttrs = (
  resourceGroup: string,
  observed: ObservedConfiguration,
): PartnerConfiguration["Attributes"] => ({
  partnerConfigurationId: observed.id ?? "",
  resourceGroup,
  defaultMaximumExpirationTimeInDays:
    observed.properties?.partnerAuthorization
      ?.defaultMaximumExpirationTimeInDays,
  authorizedPartnerIds: (
    observed.properties?.partnerAuthorization?.authorizedPartnersList ?? []
  ).flatMap((partner) =>
    partner.partnerRegistrationImmutableId === undefined
      ? []
      : [partner.partnerRegistrationImmutableId],
  ),
  tags: userTags(observed.tags),
});

/** Whether the observed authorized partners differ from the desired ones. */
const partnersDiffer = (
  observed: readonly eventgrid.Partner[] | undefined,
  desired: readonly AuthorizedPartner[],
) => {
  if ((observed ?? []).length !== desired.length) return true;
  return desired.some((want) => {
    const have = (observed ?? []).find((partner) =>
      sameName(
        partner.partnerRegistrationImmutableId,
        want.partnerRegistrationImmutableId,
      ),
    );
    return (
      have === undefined ||
      (want.partnerName !== undefined &&
        want.partnerName !== have.partnerName) ||
      (want.authorizationExpirationTimeInUtc !== undefined &&
        Date.parse(want.authorizationExpirationTimeInUtc) !==
          Date.parse(have.authorizationExpirationTimeInUtc ?? ""))
    );
  });
};

const provisioned = (configuration: ObservedConfiguration) =>
  configuration.properties?.provisioningState;

export const PartnerConfigurationProvider = () =>
  Provider.succeed(PartnerConfiguration, {
    stables: ["partnerConfigurationId", "resourceGroup"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* eventgrid
        .ListPartnerConfigurationBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListPartnerConfigurationBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((configuration) => {
        const group = resourceGroupOf(configuration.id);
        return hasAnyAlchemyTag(configuration.tags) && group !== undefined
          ? [toAttrs(group, configuration)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (!sameName(news.resourceGroup, output.resourceGroup)) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const observed = yield* getConfiguration(subscriptionId, resourceGroup);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.EventGrid");
      const resourceGroup = news.resourceGroup;
      const tags = yield* desiredTags(id, news.tags);
      const partners = news.authorizedPartners ?? [];
      const days = news.defaultMaximumExpirationTimeInDays;
      const get = getConfiguration(subscriptionId, resourceGroup);
      const label = `event grid partner configuration in ${resourceGroup}`;
      const put = eventgrid.PartnerConfigurationsCreateOrUpdate({
        subscriptionId,
        resourceGroupName: resourceGroup,
        location: "global",
        tags,
        properties: {
          partnerAuthorization: {
            defaultMaximumExpirationTimeInDays: days,
            authorizedPartnersList: partners,
          },
        },
      });

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* put;
      }
      observed = yield* waitForProvisioned(label, get, provisioned);

      // Sync. PATCH covers tags and the expiry; the partner list needs a PUT.
      const authorization = observed.properties?.partnerAuthorization;
      if (partnersDiffer(authorization?.authorizedPartnersList, partners)) {
        yield* put;
        observed = yield* waitForProvisioned(label, get, provisioned);
      } else {
        const daysChanged =
          days !== undefined &&
          days !== authorization?.defaultMaximumExpirationTimeInDays;
        const tagsChanged = tagsDiffer(observed.tags, tags);
        if (daysChanged || tagsChanged) {
          yield* eventgrid.UpdatePartnerConfiguration({
            subscriptionId,
            resourceGroupName: resourceGroup,
            tags: tagsChanged ? tags : undefined,
            properties: daysChanged
              ? { defaultMaximumExpirationTimeInDays: days }
              : undefined,
          });
          observed = yield* waitForProvisioned(label, get, provisioned);
        }
      }

      return toAttrs(resourceGroup, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        eventgrid.DeletePartnerConfiguration({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
        }),
      );
      yield* waitUntilGone(
        `event grid partner configuration in ${output.resourceGroup}`,
        getConfiguration(subscriptionId, output.resourceGroup),
        { times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
