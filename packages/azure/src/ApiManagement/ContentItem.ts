import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { createEntityName, subsetMatches } from "./Common.ts";
import { entityLifecycle } from "./Entity.ts";

export interface ContentItemProps {
  /**
   * Resource group of the API Management service.
   * Changing it replaces the content item.
   */
  resourceGroup: string;
  /**
   * API Management service whose developer portal holds the content item.
   * Changing it replaces the content item.
   */
  serviceName: string;
  /**
   * Content type of the item: a built-in type such as `url` or `page`, or
   * a custom {@link ContentType} (`contentType.contentTypeName`).
   * Changing it replaces the content item.
   */
  contentTypeName: string;
  /**
   * Content item identifier, unique within its content type.
   * Changing it replaces the content item.
   * @default a name generated from the stack, stage, and logical ID
   */
  name?: string;
  /**
   * Content of the item. Its shape is defined by the content type's
   * schema, e.g. `{ en_us: { title, description, permalink } }` for a
   * `url` item.
   */
  properties: Record<string, unknown>;
}

export interface ContentItem extends Resource<
  "Azure.ApiManagement.ContentItem",
  ContentItemProps,
  {
    /** Content item identifier within its content type. */
    contentItemName: string;
    /** ARM resource ID of the content item. */
    contentItemId: string;
    /** Content type of the item. */
    contentTypeName: string;
    /** API Management service that holds the content item. */
    serviceName: string;
    /** Resource group of the service. */
    resourceGroup: string;
  },
  never,
  Providers
> {}

/**
 * A developer portal content item
 * (`Microsoft.ApiManagement/service/contentTypes/contentItems`): one
 * page, link, layout, or custom entry of the developer portal, shaped by
 * its content type's schema. Needs a tier with a developer portal (not
 * Consumption). Publish the portal to make changes visible to visitors.
 *
 * :::caution
 * Changing `name`, `contentTypeName`, `serviceName`, or `resourceGroup`
 * replaces the content item.
 * :::
 *
 * @see https://learn.microsoft.com/rest/api/apimanagement/content-item
 *
 * ### Creating Content Items
 * **Example:** A link in the developer portal
 * ```typescript
 * yield* Azure.ApiManagement.ContentItem("docs-link", {
 *   serviceName: apim.serviceName,
 *   contentTypeName: "url",
 *   name: "docs",
 *   properties: {
 *     en_us: {
 *       title: "Docs",
 *       description: "Product documentation",
 *       permalink: "https://example.com/docs",
 *     },
 *   },
 * });
 * ```
 *
 * **Example:** An entry of a custom content type
 * ```typescript
 * yield* Azure.ApiManagement.ContentItem("faq-keys", {
 *   serviceName: apim.serviceName,
 *   contentTypeName: faq.contentTypeName,
 *   properties: { question: "Where is my key?", answer: "On your profile page." },
 * });
 * ```
 *
 * @resource
 */
export const ContentItem = GroupedResource<ContentItem>("Azure.ApiManagement.ContentItem");

interface Key {
  resourceGroup: string;
  serviceName: string;
  contentTypeName: string;
  contentItemName: string;
}

export const ContentItemProvider = () =>
  Provider.succeed(ContentItem, {
    stables: [
      "contentItemName",
      "contentItemId",
      "contentTypeName",
      "serviceName",
      "resourceGroup",
    ],
    ...entityLifecycle<
      ContentItemProps,
      ContentItem["Attributes"],
      Key,
      apim.GetContentItemResponse
    >({
      label: (key) => `API Management content item ${key.contentTypeName}/${key.contentItemName}`,
      keyOf: (props, id, output) =>
        Effect.gen(function* () {
          return {
            resourceGroup: props.resourceGroup,
            serviceName: props.serviceName,
            contentTypeName: props.contentTypeName,
            contentItemName: props.name ?? output?.contentItemName ?? (yield* createEntityName(id)),
          };
        }),
      keyOfAttrs: (attrs) => attrs,
      get: (subscriptionId, key) =>
        apim.GetContentItem({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          contentTypeId: key.contentTypeName,
          contentItemId: key.contentItemName,
        }),
      put: (subscriptionId, key, news) =>
        apim.ContentItemCreateOrUpdate({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          contentTypeId: key.contentTypeName,
          contentItemId: key.contentItemName,
          properties: news.properties,
        }),
      remove: (subscriptionId, key) =>
        apim.DeleteContentItem({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          contentTypeId: key.contentTypeName,
          contentItemId: key.contentItemName,
        }),
      inSync: (news, observed) => subsetMatches(news.properties, observed.properties),
      toAttrs: (_subscriptionId, key, observed) => ({
        resourceGroup: key.resourceGroup,
        serviceName: key.serviceName,
        contentTypeName: key.contentTypeName,
        contentItemName: key.contentItemName,
        contentItemId: observed.id ?? "",
      }),
    }),
  });
