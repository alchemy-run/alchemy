import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createEntityName } from "./Common.ts";
import { entityLifecycle } from "./Entity.ts";

export interface DocumentationProps {
  /** Resource group of the API Management service. Changing it replaces the page. */
  resourceGroup: string;
  /** API Management service that holds the page. Changing it replaces the page. */
  serviceName: string;
  /**
   * Documentation identifier, unique within the service. Changing it
   * replaces the page.
   * @default a name generated from the stack, stage, and logical ID
   */
  name?: string;
  /** Title of the page. */
  title: string;
  /** Markdown content of the page. */
  content: string;
}

export interface Documentation extends Resource<
  "Azure.ApiManagement.Documentation",
  DocumentationProps,
  {
    /** Documentation identifier within the service. */
    documentationName: string;
    /** ARM resource ID of the page. */
    documentationId: string;
    /** API Management service that holds the page. */
    serviceName: string;
    /** Resource group of the service. */
    resourceGroup: string;
    /** Title of the page. */
    title: string;
  },
  never,
  Providers
> {}

/**
 * A Markdown documentation page of an API Management service. Wikis
 * ({@link ApiWiki}, {@link ProductWiki}) list pages to show them with an
 * API or product in the developer portal.
 *
 * @see https://learn.microsoft.com/rest/api/apimanagement/documentation
 *
 * ### Writing Documentation
 * **Example:** A getting-started page
 * ```typescript
 * const page = yield* Azure.ApiManagement.Documentation("getting-started", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   title: "Getting started",
 *   content: "# Getting started\nSubscribe to the Starter product.",
 * });
 * ```
 *
 * @resource
 */
export const Documentation = Resource<Documentation>(
  "Azure.ApiManagement.Documentation",
);

interface Key {
  resourceGroup: string;
  serviceName: string;
  documentationName: string;
}

export const DocumentationProvider = () =>
  Provider.succeed(Documentation, {
    stables: [
      "documentationName",
      "documentationId",
      "serviceName",
      "resourceGroup",
    ],
    ...entityLifecycle<
      DocumentationProps,
      Documentation["Attributes"],
      Key,
      apim.GetDocumentationResponse
    >({
      label: (key) => `API Management documentation ${key.documentationName}`,
      keyOf: (props, id, output) =>
        Effect.gen(function* () {
          return {
            resourceGroup: props.resourceGroup,
            serviceName: props.serviceName,
            documentationName:
              props.name ??
              output?.documentationName ??
              (yield* createEntityName(id)),
          };
        }),
      keyOfAttrs: (attrs) => attrs,
      get: (subscriptionId, key) =>
        apim.GetDocumentation({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          documentationId: key.documentationName,
        }),
      put: (subscriptionId, key, news) =>
        apim.DocumentationCreateOrUpdate({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          documentationId: key.documentationName,
          properties: { title: news.title, content: news.content },
        }),
      remove: (subscriptionId, key) =>
        apim.DeleteDocumentation({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          documentationId: key.documentationName,
        }),
      inSync: (news, observed) =>
        observed.properties?.title === news.title &&
        observed.properties?.content === news.content,
      toAttrs: (_subscriptionId, key, observed) => ({
        resourceGroup: key.resourceGroup,
        serviceName: key.serviceName,
        documentationName: key.documentationName,
        documentationId: observed.id ?? "",
        title: observed.properties?.title ?? "",
      }),
    }),
  });
