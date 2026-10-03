import * as confluent from "@distilled.cloud/azure/confluent";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
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
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { canonicalJson, getOrganization, sameName } from "./common.ts";

/** Azure Marketplace offer the organization subscribes to. */
export interface ConfluentOfferDetail {
  /**
   * Marketplace publisher ID.
   * @default "confluentinc"
   */
  publisherId?: string;
  /**
   * Marketplace offer ID.
   * @default "confluent-cloud-azure-prod"
   */
  id?: string;
  /**
   * Marketplace plan ID.
   * @default "confluent-cloud-azure-payg-prod"
   */
  planId?: string;
  /**
   * Marketplace plan display name.
   * @default "Confluent Cloud - Pay as you Go"
   */
  planName?: string;
  /**
   * Billing term unit of the plan, e.g. `P1M` (monthly) or `P1Y`.
   * @default "P1M"
   */
  termUnit?: string;
  /** Billing term ID of the plan. */
  termId?: string;
  /** Private offer ID, for a negotiated private offer. */
  privateOfferId?: string;
  /** Private offer IDs, for negotiated private offers. */
  privateOfferIds?: string[];
}

/** The Confluent Cloud user the organization is provisioned for. */
export interface ConfluentUserDetail {
  /** Email address of the organization's first user (required). */
  emailAddress: string;
  /** First name of the user. */
  firstName?: string;
  /** Last name of the user. */
  lastName?: string;
  /** Microsoft Entra user principal name of the user. */
  userPrincipalName?: string;
  /** Microsoft Entra email address of the user. */
  aadEmail?: string;
}

export interface OrganizationProps {
  /**
   * Resource group the organization is created in. Changing it replaces the
   * organization.
   */
  resourceGroup: string;
  /**
   * Name of the organization resource, 1-50 letters, digits, `-`, `_`, and
   * `.`. If omitted, a unique name is generated from the app, stage, and
   * logical ID. Changing it replaces the organization.
   */
  name?: string;
  /**
   * Azure location of the organization. Changing it replaces the
   * organization.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Azure Marketplace offer and plan to subscribe to. Changing it replaces
   * the organization.
   * @default the Confluent Cloud pay-as-you-go plan
   */
  offerDetail?: ConfluentOfferDetail;
  /**
   * The Confluent Cloud user the organization is provisioned for. Changing
   * it replaces the organization.
   */
  userDetail: ConfluentUserDetail;
  /**
   * Confluent Cloud auth token that links an existing Confluent organization
   * instead of creating a new one. Changing it replaces the organization.
   */
  linkOrganizationToken?: Redacted.Redacted<string>;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Organization extends Resource<
  "Azure.Confluent.Organization",
  OrganizationProps,
  {
    /** Name of the organization resource. */
    organizationName: string;
    /** Resource group that holds the organization. */
    resourceGroup: string;
    /** ARM resource ID of the organization. */
    organizationResourceId: string;
    /** Location of the organization. */
    location: string;
    /** Confluent Cloud organization ID. */
    organizationId: string;
    /** Single sign-on URL of the Confluent Cloud organization. */
    ssoUrl: string | undefined;
    /** Marketplace offer ID the organization subscribes to. */
    offerId: string;
    /** Marketplace plan ID the organization subscribes to. */
    planId: string;
    /** Status of the Marketplace SaaS subscription, e.g. `Subscribed`. */
    offerStatus: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A Confluent Cloud organization provisioned as an Azure Native ISV Service
 * (`Microsoft.Confluent/organizations`). Creating it subscribes to a
 * Confluent Cloud plan through Azure Marketplace and bills through the Azure
 * subscription; deleting it cancels the SaaS subscription.
 *
 * The subscription must allow Marketplace purchases (free trial and
 * sponsored subscriptions cannot) and have accepted the Confluent
 * Marketplace terms. Environments, clusters, topics, and connectors are
 * managed as children of the organization.
 *
 * @see https://learn.microsoft.com/azure/partner-solutions/apache-kafka-confluent-cloud/overview
 *
 * ### Creating an Organization
 * **Example:** Pay-as-you-go organization
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("streaming");
 * const org = yield* Azure.Confluent.Organization("kafka", {
 *   resourceGroup: group.resourceGroupName,
 *   userDetail: { emailAddress: "platform@example.com" },
 * });
 * ```
 *
 * **Example:** Linking an existing Confluent Cloud organization
 * ```typescript
 * const org = yield* Azure.Confluent.Organization("kafka", {
 *   resourceGroup: group.resourceGroupName,
 *   userDetail: { emailAddress: "platform@example.com" },
 *   linkOrganizationToken: Redacted.make(process.env.CONFLUENT_LINK_TOKEN!),
 * });
 * ```
 *
 * @resource
 */
export const Organization = Resource<Organization>(
  "Azure.Confluent.Organization",
);

type ObservedOrganization = confluent.GetOrganizationResponse;

const createOrganizationName = (id: string) =>
  createPhysicalName({ id, maxLength: 50 });

const desiredOffer = (offer: ConfluentOfferDetail | undefined) => ({
  publisherId: offer?.publisherId ?? "confluentinc",
  id: offer?.id ?? "confluent-cloud-azure-prod",
  planId: offer?.planId ?? "confluent-cloud-azure-payg-prod",
  planName: offer?.planName ?? "Confluent Cloud - Pay as you Go",
  termUnit: offer?.termUnit ?? "P1M",
  termId: offer?.termId,
  privateOfferId: offer?.privateOfferId,
  privateOfferIds: offer?.privateOfferIds,
});

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: ObservedOrganization,
): Organization["Attributes"] => ({
  organizationName: name,
  resourceGroup,
  organizationResourceId: observed.id ?? "",
  location: observed.location,
  organizationId: observed.properties?.organizationId ?? "",
  ssoUrl: observed.properties?.ssoUrl,
  offerId: observed.properties?.offerDetail?.id ?? "",
  planId: observed.properties?.offerDetail?.planId ?? "",
  offerStatus: observed.properties?.offerDetail?.status,
  tags: userTags(observed.tags),
});

const waitForOrganization = (
  subscriptionId: string,
  resourceGroup: string,
  name: string,
) =>
  waitForProvisioned(
    `Confluent organization ${name}`,
    getOrganization(subscriptionId, resourceGroup, name),
    (org) => org.properties?.provisioningState,
    { interval: "10 seconds", times: 60 },
  );

export const OrganizationProvider = () =>
  Provider.succeed(Organization, {
    stables: [
      "organizationName",
      "resourceGroup",
      "organizationResourceId",
      "location",
      "organizationId",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* confluent
        .ListOrganizationBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListOrganizationBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((org) => {
        const group = resourceGroupOf(org.id);
        return hasAnyAlchemyTag(org.tags) &&
          group !== undefined &&
          org.name !== undefined
          ? [toAttrs(group, org.name, org)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined &&
          !sameName(news.name, output.organizationName)) ||
        (news.location !== undefined &&
          !sameName(news.location, output.location))
      ) {
        return { action: "replace" } as const;
      }
      const offer = desiredOffer(news.offerDetail);
      if (
        (output.offerId !== "" && !sameName(offer.id, output.offerId)) ||
        (output.planId !== "" && !sameName(offer.planId, output.planId))
      ) {
        return { action: "replace" } as const;
      }
      if (olds !== undefined) {
        const oldToken =
          olds.linkOrganizationToken === undefined
            ? undefined
            : Redacted.value(olds.linkOrganizationToken);
        const newToken =
          news.linkOrganizationToken === undefined
            ? undefined
            : Redacted.value(news.linkOrganizationToken);
        if (
          canonicalJson(desiredOffer(olds.offerDetail)) !==
            canonicalJson(offer) ||
          canonicalJson(olds.userDetail) !== canonicalJson(news.userDetail) ||
          oldToken !== newToken
        ) {
          return { action: "replace" } as const;
        }
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.organizationName ??
        olds?.name ??
        (yield* createOrganizationName(id));
      const observed = yield* getOrganization(
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
      yield* ensureRegistered(subscriptionId, "Microsoft.Confluent");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ??
        output?.organizationName ??
        (yield* createOrganizationName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);

      // Observe.
      let observed = yield* getOrganization(
        subscriptionId,
        resourceGroup,
        name,
      );

      // Ensure: the PUT subscribes to the Marketplace offer and provisions
      // the Confluent organization in the background.
      if (observed === undefined) {
        yield* confluent.CreateOrganization({
          subscriptionId,
          resourceGroupName: resourceGroup,
          organizationName: name,
          location,
          tags,
          properties: {
            offerDetail: desiredOffer(news.offerDetail),
            userDetail: news.userDetail,
            linkOrganization:
              news.linkOrganizationToken === undefined
                ? undefined
                : { token: Redacted.value(news.linkOrganizationToken) },
          },
        });
      }
      observed = yield* waitForOrganization(
        subscriptionId,
        resourceGroup,
        name,
      );

      // Sync tags (the only mutable aspect) against the observed tags.
      if (tagsDiffer(observed.tags, tags)) {
        yield* confluent.UpdateOrganization({
          subscriptionId,
          resourceGroupName: resourceGroup,
          organizationName: name,
          tags,
        });
        observed = yield* waitForOrganization(
          subscriptionId,
          resourceGroup,
          name,
        );
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        confluent.DeleteOrganization({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          organizationName: output.organizationName,
        }),
      );
      yield* waitUntilGone(
        `Confluent organization ${output.organizationName}`,
        getOrganization(
          subscriptionId,
          output.resourceGroup,
          output.organizationName,
        ),
        { interval: "10 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
