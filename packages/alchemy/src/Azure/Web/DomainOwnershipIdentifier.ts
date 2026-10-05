import * as web from "@distilled.cloud/azure/web";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { lower, siteWhere } from "./common.ts";

export interface DomainOwnershipIdentifierProps {
  /** Resource group of the app. Changing it replaces the identifier. */
  resourceGroup: string;
  /** Name of the web app or function app. Changing it replaces it. */
  siteName: string;
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
 * (`Microsoft.Web/sites/domainOwnershipIdentifiers`): a named value that
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
 *   resourceGroup: group.resourceGroupName,
 *   siteName: app.siteName,
 *   value: otherApp.customDomainVerificationId,
 * });
 * ```
 *
 * @resource
 */
export const DomainOwnershipIdentifier = Resource<DomainOwnershipIdentifier>(
  "Azure.Web.DomainOwnershipIdentifier",
);

type ObservedIdentifier = web.GetWebAppDomainOwnershipIdentifierResponse;

const createIdentifierName = (id: string) =>
  createPhysicalName({ id, maxLength: 60, lowercase: true });

const getIdentifier = (
  subscriptionId: string,
  resourceGroup: string,
  siteName: string,
  identifierName: string,
) =>
  orUndefinedIfNotFound(
    web.GetWebAppDomainOwnershipIdentifier({
      ...siteWhere(subscriptionId, resourceGroup, siteName),
      domainOwnershipIdentifierName: identifierName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  siteName: string,
  identifierName: string,
  observed: ObservedIdentifier,
): DomainOwnershipIdentifier["Attributes"] => ({
  identifierName,
  identifierId: observed.id ?? "",
  siteName,
  resourceGroup,
  value: observed.properties?.value,
});

export const DomainOwnershipIdentifierProvider = () =>
  Provider.succeed(DomainOwnershipIdentifier, {
    stables: ["identifierName", "identifierId", "siteName", "resourceGroup"],

    // Identifiers are removed with their app.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.siteName) !== lower(output.siteName) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.identifierName))
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
      const identifierName =
        output?.identifierName ??
        olds?.name ??
        (yield* createIdentifierName(id));
      const observed = yield* getIdentifier(
        subscriptionId,
        resourceGroup,
        siteName,
        identifierName,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, siteName, identifierName, observed);
      // Identifiers carry no tags; only one this stack recorded is ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Web");
      const { resourceGroup, siteName } = news;
      const identifierName =
        news.name ??
        output?.identifierName ??
        (yield* createIdentifierName(id));
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
        identifierName,
      );

      // Ensure + sync the value (a synchronous PUT/PATCH).
      const result =
        observed === undefined
          ? yield* web.WebAppsCreateOrUpdateDomainOwnershipIdentifier(request)
          : observed.properties?.value !== news.value
            ? yield* web.UpdateWebAppDomainOwnershipIdentifier(request)
            : observed;
      return toAttrs(resourceGroup, siteName, identifierName, result);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        web.DeleteWebAppDomainOwnershipIdentifier({
          ...siteWhere(subscriptionId, output.resourceGroup, output.siteName),
          domainOwnershipIdentifierName: output.identifierName,
        }),
      );
      yield* waitUntilGone(
        `domain ownership identifier ${output.identifierName}`,
        getIdentifier(
          subscriptionId,
          output.resourceGroup,
          output.siteName,
          output.identifierName,
        ),
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceGroup",
        "Azure.Web.WebApp",
        "Azure.Web.FunctionApp",
      ],
    },
  });
