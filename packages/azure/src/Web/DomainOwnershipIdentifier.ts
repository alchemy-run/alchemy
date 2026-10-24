import * as web from "@distilled.cloud/azure/web";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { ensureRegistered, ignoreNotFound, orUndefinedIfNotFound, waitUntilGone } from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { lower, siteWhere } from "./common.ts";

export interface DomainOwnershipIdentifierProps {
  /** Resource group of the app. Changing it replaces the identifier. */
  resourceGroup: string;
  /** Name of the web app or function app. Changing it replaces it. */
  siteName: string;
  /**
   * Deployment slot of the app. Changing it replaces the identifier.
   * @default the production slot
   */
  slot?: string;
  /**
   * Name of the identifier. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the identifier.
   */
  name?: string;
  /**
   * Value of the identifier, e.g. the custom domain verification ID of
   * another app that should be allowed to bind the same domain.
   */
  value: string;
}

export interface DomainOwnershipIdentifier extends Resource<
  "Azure.Web.DomainOwnershipIdentifier",
  DomainOwnershipIdentifierProps,
  {
    /** Name of the identifier. */
    identifierName: string;
    /** ARM resource ID of the identifier. */
    identifierId: string;
    /** Name of the app. */
    siteName: string;
    /** Deployment slot, if slot-scoped. */
    slot: string | undefined;
    /** Resource group of the app. */
    resourceGroup: string;
    /** Value of the identifier. */
    value: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A domain ownership identifier of an App Service app
 * (`Microsoft.Web/sites/domainOwnershipIdentifiers`, or
 * `sites/slots/domainOwnershipIdentifiers` with `slot`): a named value that
 * App Service accepts as proof of ownership when another app binds a custom
 * domain already verified for this one.
 *
 * Microsoft.Web currently rejects every identifier create with HTTP 404
 * `NotFound` ("Cannot find WebSiteDomainVerificationIdentifier with name
 * ..."), on every api-version; existing identifiers can still be read,
 * updated and deleted.
 *
 * @see https://learn.microsoft.com/azure/app-service/app-service-web-tutorial-custom-domain
 *
 * ### Registering an Identifier
 * **Example:** Allow a second app to bind the same domain
 * ```typescript
 * yield* Azure.Web.DomainOwnershipIdentifier("ownership", {
 *   siteName: app.siteName,
 *   value: otherApp.customDomainVerificationId,
 * });
 * ```
 *
 * @resource
 */
export const DomainOwnershipIdentifier = GroupedResource<DomainOwnershipIdentifier>(
  "Azure.Web.DomainOwnershipIdentifier",
);

type ObservedIdentifier = web.GetWebAppDomainOwnershipIdentifierResponse;

const createIdentifierName = (id: string) =>
  createPhysicalName({ id, maxLength: 60, lowercase: true });

const getIdentifier = (
  subscriptionId: string,
  resourceGroup: string,
  siteName: string,
  slot: string | undefined,
  identifierName: string,
) => {
  const where = {
    ...siteWhere(subscriptionId, resourceGroup, siteName),
    domainOwnershipIdentifierName: identifierName,
  };
  return orUndefinedIfNotFound(
    slot === undefined
      ? web.GetWebAppDomainOwnershipIdentifier(where)
      : web.GetWebAppDomainOwnershipIdentifierSlot({ ...where, slot }),
  );
};

const toAttrs = (
  resourceGroup: string,
  siteName: string,
  slot: string | undefined,
  identifierName: string,
  observed: ObservedIdentifier,
): DomainOwnershipIdentifier["Attributes"] => ({
  identifierName,
  identifierId: observed.id ?? "",
  siteName,
  slot,
  resourceGroup,
  value: observed.properties?.value,
});

export const DomainOwnershipIdentifierProvider = () =>
  Provider.succeed(DomainOwnershipIdentifier, {
    stables: ["identifierName", "identifierId", "siteName", "slot", "resourceGroup"],

    // Identifiers are removed with their app.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.siteName) !== lower(output.siteName) ||
        lower(news.slot) !== lower(output.slot) ||
        (news.name !== undefined && lower(news.name) !== lower(output.identifierName))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const siteName = output?.siteName ?? olds?.siteName;
      if (resourceGroup === undefined || siteName === undefined) {
        return undefined;
      }
      const slot = output?.slot ?? olds?.slot;
      const identifierName =
        output?.identifierName ?? olds?.name ?? (yield* createIdentifierName(id));
      const observed = yield* getIdentifier(
        subscriptionId,
        resourceGroup,
        siteName,
        slot,
        identifierName,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, siteName, slot, identifierName, observed);
      // Identifiers carry no tags; only one this stack recorded is ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Web");
      const { resourceGroup, siteName, slot } = news;
      const identifierName =
        news.name ?? output?.identifierName ?? (yield* createIdentifierName(id));
      const request = {
        ...siteWhere(subscriptionId, resourceGroup, siteName),
        domainOwnershipIdentifierName: identifierName,
        properties: { value: news.value },
      };

      // Observe.
      const observed = yield* getIdentifier(
        subscriptionId,
        resourceGroup,
        siteName,
        slot,
        identifierName,
      );

      // Ensure + sync the value (a synchronous PUT/PATCH).
      const result =
        observed === undefined
          ? slot === undefined
            ? yield* web.WebAppsCreateOrUpdateDomainOwnershipIdentifier(request)
            : yield* web.WebAppsCreateOrUpdateDomainOwnershipIdentifierSlot({ ...request, slot })
          : observed.properties?.value !== news.value
            ? slot === undefined
              ? yield* web.UpdateWebAppDomainOwnershipIdentifier(request)
              : yield* web.UpdateWebAppDomainOwnershipIdentifierSlot({ ...request, slot })
            : observed;
      return toAttrs(resourceGroup, siteName, slot, identifierName, result);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where = {
        ...siteWhere(subscriptionId, output.resourceGroup, output.siteName),
        domainOwnershipIdentifierName: output.identifierName,
      };
      yield* ignoreNotFound(
        output.slot === undefined
          ? web.DeleteWebAppDomainOwnershipIdentifier(where)
          : web.DeleteWebAppDomainOwnershipIdentifierSlot({ ...where, slot: output.slot }),
      );
      yield* waitUntilGone(
        `domain ownership identifier ${output.identifierName}`,
        getIdentifier(
          subscriptionId,
          output.resourceGroup,
          output.siteName,
          output.slot,
          output.identifierName,
        ),
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceGroup",
        "Azure.Web.WebApp",
        "Azure.Web.FunctionApp",
        "Azure.Web.WebAppSlot",
      ],
    },
  });
