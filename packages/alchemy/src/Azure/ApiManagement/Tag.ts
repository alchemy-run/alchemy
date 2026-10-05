import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createEntityName } from "./Common.ts";
import { entityLifecycle } from "./Entity.ts";

export interface TagProps {
  /** Resource group of the API Management service. Changing it replaces the tag. */
  resourceGroup: string;
  /** API Management service that holds the tag. Changing it replaces the tag. */
  serviceName: string;
  /**
   * Tag identifier, unique within the service. Changing it replaces the tag.
   * @default a name generated from the stack, stage, and logical ID
   */
  name?: string;
  /**
   * Display name shown in the developer portal and used to search APIs.
   * @default the tag identifier
   */
  displayName?: string;
}

export interface Tag extends Resource<
  "Azure.ApiManagement.Tag",
  TagProps,
  {
    /** Tag identifier within the service. */
    tagName: string;
    /** ARM resource ID of the tag. */
    tagId: string;
    /** API Management service that holds the tag. */
    serviceName: string;
    /** Resource group of the service. */
    resourceGroup: string;
    /** Display name of the tag. */
    displayName: string;
  },
  never,
  Providers
> {}

/**
 * An API Management tag entity, used to group and search APIs, operations,
 * and products (via {@link TagApiLink}, {@link TagOperationLink},
 * {@link TagProductLink}, {@link ApiTagLink}, ...). These are not ARM
 * resource tags.
 *
 * @see https://learn.microsoft.com/rest/api/apimanagement/tag
 *
 * ### Creating Tags
 * **Example:** Tag an API as public
 * ```typescript
 * const tag = yield* Azure.ApiManagement.Tag("public", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   displayName: "Public",
 * });
 * yield* Azure.ApiManagement.ApiTagLink("orders-public", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   apiName: api.apiName,
 *   tagName: tag.tagName,
 * });
 * ```
 *
 * @resource
 */
export const Tag = Resource<Tag>("Azure.ApiManagement.Tag");

interface Key {
  resourceGroup: string;
  serviceName: string;
  tagName: string;
}

export const TagProvider = () =>
  Provider.succeed(Tag, {
    stables: ["tagName", "tagId", "serviceName", "resourceGroup"],
    ...entityLifecycle<TagProps, Tag["Attributes"], Key, apim.GetTagResponse>({
      label: (key) => `API Management tag ${key.tagName}`,
      keyOf: (props, id, output) =>
        Effect.gen(function* () {
          return {
            resourceGroup: props.resourceGroup,
            serviceName: props.serviceName,
            tagName:
              props.name ?? output?.tagName ?? (yield* createEntityName(id)),
          };
        }),
      keyOfAttrs: (attrs) => attrs,
      get: (subscriptionId, key) =>
        apim.GetTag({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          tagId: key.tagName,
        }),
      put: (subscriptionId, key, news) =>
        apim.TagCreateOrUpdate({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          tagId: key.tagName,
          properties: { displayName: news.displayName ?? key.tagName },
        }),
      remove: (subscriptionId, key) =>
        apim.DeleteTag({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          tagId: key.tagName,
        }),
      inSync: (news, observed) =>
        observed.properties?.displayName ===
        (news.displayName ?? observed.name),
      toAttrs: (_subscriptionId, key, observed) => ({
        resourceGroup: key.resourceGroup,
        serviceName: key.serviceName,
        tagName: key.tagName,
        tagId: observed.id ?? "",
        displayName: observed.properties?.displayName ?? key.tagName,
      }),
    }),
  });
