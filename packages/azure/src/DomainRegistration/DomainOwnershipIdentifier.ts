import * as domainregistration from "@distilled.cloud/azure/domainregistration";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import { tagRecord } from "alchemy/Tags";
import * as Effect from "effect/Effect";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  stackAndStage,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";

export interface DomainOwnershipIdentifierProps {
  /**
   * Resource group of the App Service Domain. Changing it replaces the
   * identifier.
   */
  resourceGroup: string;
  /**
   * Name of the App Service Domain the identifier belongs to (pass
   * `Domain.domainName`). Changing it replaces the identifier.
   */
  domainName: string;
  /**
   * Name of the identifier. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the identifier.
   */
  name?: string;
  /**
   * The ownership ID that proves the domain belongs to you, e.g. a web
   * app's `customDomainVerificationId`.
   */
  ownershipId: string;
}

export interface DomainOwnershipIdentifier extends Resource<
  "Azure.DomainRegistration.DomainOwnershipIdentifier",
  DomainOwnershipIdentifierProps,
  {
    /** Name of the identifier. */
    name: string;
    /** Name of the App Service Domain. */
    domainName: string;
    /** Resource group of the domain. */
    resourceGroup: string;
    /**
     * ARM resource ID of the identifier
     * (`.../Microsoft.DomainRegistration/domains/{domain}/domainOwnershipIdentifiers/{name}`).
     */
    identifierId: string;
    /** The ownership ID recorded on the domain. */
    ownershipId: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An ownership identifier of an App Service Domain
 * (`Microsoft.DomainRegistration/domains/domainOwnershipIdentifiers`). It
 * records an ownership ID on the domain, such as a web app's
 * `customDomainVerificationId`, so Azure services can verify that the
 * domain belongs to you without a DNS TXT record.
 *
 * The identifier needs an existing App Service Domain (see
 * {@link Domain}). Identifiers have no tags: ownership follows the domain's
 * Alchemy tags.
 *
 * :::caution
 * Changing `resourceGroup`, `domainName`, or `name` replaces the
 * identifier.
 * :::
 *
 * @see https://learn.microsoft.com/rest/api/appservice/domains/create-or-update-ownership-identifier
 *
 * ### Verifying Domain Ownership
 * **Example:** Record a web app's verification ID on a domain
 * ```typescript
 * const domain = yield* Azure.DomainRegistration.Domain("example", {
 *   domainName: "example.com",
 *   contactRegistrant: {
 *     email: "hostmaster@example.com",
 *     nameFirst: "Ada",
 *     nameLast: "Lovelace",
 *     phone: "+1.4255550100",
 *   },
 *   consent: { agreedBy: "203.0.113.10" },
 * });
 * yield* Azure.DomainRegistration.DomainOwnershipIdentifier("app-verification", {
 *   domainName: domain.domainName,
 *   // the web app's `customDomainVerificationId`
 *   ownershipId: "5F4C0E2B3A1D4C8E9F7A6B5C4D3E2F1A0B9C8D7E6F5A4B3C2D1E0F9A8B7C6D5E",
 * });
 * ```
 *
 * @resource
 */
export const DomainOwnershipIdentifier = GroupedResource<DomainOwnershipIdentifier>(
  "Azure.DomainRegistration.DomainOwnershipIdentifier",
);

type ObservedIdentifier = domainregistration.GetDomainOwnershipIdentifierResponse;

const getIdentifier = (
  subscriptionId: string,
  resourceGroupName: string,
  domainName: string,
  name: string,
) =>
  orUndefinedIfNotFound(
    domainregistration.GetDomainOwnershipIdentifier({
      subscriptionId,
      resourceGroupName,
      domainName,
      name,
    }),
  );

const identifierIdOf = (
  subscriptionId: string,
  resourceGroup: string,
  domainName: string,
  name: string,
) =>
  `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.DomainRegistration/domains/${domainName}/domainOwnershipIdentifiers/${name}`;

const toAttrs = (
  subscriptionId: string,
  resourceGroup: string,
  domainName: string,
  name: string,
  observed: ObservedIdentifier,
): DomainOwnershipIdentifier["Attributes"] => ({
  name,
  domainName,
  resourceGroup,
  identifierId: observed.id ?? identifierIdOf(subscriptionId, resourceGroup, domainName, name),
  ownershipId: observed.properties?.ownershipId,
});

/** Whether the parent domain carries this stack and stage's tags. */
const isDomainOwnedByStack = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  domainName: string,
) {
  const domain = yield* orUndefinedIfNotFound(
    domainregistration.GetDomain({ subscriptionId, resourceGroupName, domainName }),
  );
  if (domain === undefined) return false;
  const { stack, stage } = yield* stackAndStage;
  const tags = tagRecord(domain.tags);
  return tags["alchemy::stack"] === stack && tags["alchemy::stage"] === stage;
});

const lower = (value: string | undefined) => value?.toLowerCase();

export const DomainOwnershipIdentifierProvider = () =>
  Provider.succeed(DomainOwnershipIdentifier, {
    stables: ["name", "domainName", "resourceGroup", "identifierId"],

    // Identifiers live inside a domain; deleting the domain removes them.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.domainName) !== lower(output.domainName) ||
        (news.name !== undefined && lower(news.name) !== lower(output.name))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const domainName = output?.domainName ?? olds?.domainName;
      if (resourceGroup === undefined || domainName === undefined) return undefined;
      const name = output?.name ?? olds?.name ?? (yield* createPhysicalName({ id }));
      const observed = yield* getIdentifier(subscriptionId, resourceGroup, domainName, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(subscriptionId, resourceGroup, domainName, name, observed);
      return (yield* isDomainOwnedByStack(subscriptionId, resourceGroup, domainName))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.DomainRegistration");
      const { resourceGroup, domainName, ownershipId } = news;
      const name = news.name ?? output?.name ?? (yield* createPhysicalName({ id }));

      // Observe; the PUT is a synchronous upsert of the single mutable
      // field, sent only when the observed value differs.
      let observed = yield* getIdentifier(subscriptionId, resourceGroup, domainName, name);
      if (observed === undefined || observed.properties?.ownershipId !== ownershipId) {
        observed = yield* domainregistration.DomainsCreateOrUpdateOwnershipIdentifier({
          subscriptionId,
          resourceGroupName: resourceGroup,
          domainName,
          name,
          properties: { ownershipId },
        });
      }
      return toAttrs(subscriptionId, resourceGroup, domainName, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        domainregistration.DeleteDomainOwnershipIdentifier({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          domainName: output.domainName,
          name: output.name,
        }),
      );
      yield* waitUntilGone(
        `domain ownership identifier ${output.name}`,
        getIdentifier(subscriptionId, output.resourceGroup, output.domainName, output.name),
      );
    }),

    nuke: { dependsOn: ["Azure.DomainRegistration.Domain"] },
  });
