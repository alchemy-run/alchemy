import * as apim from "@distilled.cloud/azure/apimanagement";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { subsetMatches } from "./Common.ts";
import { entityLifecycle } from "./Entity.ts";

export interface ContentTypeProps {
  /**
   * Resource group of the API Management service.
   * Changing it replaces the content type.
   */
  resourceGroup: string;
  /**
   * API Management service whose developer portal holds the content type.
   * Changing it replaces the content type.
   */
  serviceName: string;
  /**
   * Content type identifier. Custom content types must start with `c-`.
   * Changing it replaces the content type.
   * @default `c-` followed by a name generated from the stack, stage, and logical ID
   */
  name?: string;
  /**
   * Display name of the content type (1-250 characters).
   * @default the content type identifier
   */
  displayName?: string;
  /**
   * Description of the content type.
   * @default no description
   */
  description?: string;
  /**
   * JSON schema of the content items of this type: their properties,
   * validation rules, and constraints.
   * @default not set
   */
  schema?: Record<string, unknown>;
  /**
   * Version of the content type.
   * @default not set
   */
  version?: string;
}

export interface ContentType extends Resource<
  "Azure.ApiManagement.ContentType",
  ContentTypeProps,
  {
    /** Content type identifier. */
    contentTypeName: string;
    /** ARM resource ID of the content type. */
    contentTypeId: string;
    /** API Management service that holds the content type. */
    serviceName: string;
    /** Resource group of the service. */
    resourceGroup: string;
    /** Display name of the content type. */
    displayName: string;
  },
  never,
  Providers
> {}

/**
 * A custom developer portal content type
 * (`Microsoft.ApiManagement/service/contentTypes`). A content type
 * describes the properties, validation rules, and constraints of the
 * developer portal's {@link ContentItem}s. Built-in content types (`page`,
 * `url`, `layout`, ...) cannot be changed; custom identifiers start with
 * `c-`. Needs a tier with a developer portal (not Consumption).
 *
 * :::caution
 * Changing `name`, `serviceName`, or `resourceGroup` replaces the content
 * type.
 * :::
 *
 * @see https://learn.microsoft.com/rest/api/apimanagement/content-type
 *
 * ### Creating Content Types
 * **Example:** A content type for FAQ entries
 * ```typescript
 * const apim = yield* Azure.ApiManagement.Service("gateway", {
 *   sku: { name: "BasicV2", capacity: 1 },
 *   publisherEmail: "ops@example.com",
 *   publisherName: "Example Inc",
 * });
 * const faq = yield* Azure.ApiManagement.ContentType("faq", {
 *   serviceName: apim.serviceName,
 *   name: "c-faq",
 *   displayName: "FAQ entry",
 *   schema: {
 *     type: "object",
 *     required: ["question"],
 *     properties: {
 *       question: { type: "string" },
 *       answer: { type: "string" },
 *     },
 *   },
 * });
 * ```
 *
 * @resource
 */
export const ContentType = GroupedResource<ContentType>("Azure.ApiManagement.ContentType");

interface Key {
  resourceGroup: string;
  serviceName: string;
  contentTypeName: string;
}

export const ContentTypeProvider = () =>
  Provider.succeed(ContentType, {
    stables: ["contentTypeName", "contentTypeId", "serviceName", "resourceGroup"],
    ...entityLifecycle<
      ContentTypeProps,
      ContentType["Attributes"],
      Key,
      apim.GetContentTypeResponse
    >({
      label: (key) => `API Management content type ${key.contentTypeName}`,
      keyOf: (props, id, output) =>
        Effect.gen(function* () {
          const known = props.name ?? output?.contentTypeName;
          if (known !== undefined) {
            return {
              resourceGroup: props.resourceGroup,
              serviceName: props.serviceName,
              contentTypeName: known,
            };
          }
          const generated = yield* createPhysicalName({ id, maxLength: 78, lowercase: true });
          return {
            resourceGroup: props.resourceGroup,
            serviceName: props.serviceName,
            contentTypeName: `c-${generated}`,
          };
        }),
      keyOfAttrs: (attrs) => attrs,
      get: (subscriptionId, key) =>
        apim.GetContentType({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          contentTypeId: key.contentTypeName,
        }),
      put: (subscriptionId, key, news) =>
        apim.ContentTypeCreateOrUpdate({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          contentTypeId: key.contentTypeName,
          properties: {
            name: news.displayName ?? key.contentTypeName,
            description: news.description,
            schema: news.schema,
            version: news.version,
          },
        }),
      remove: (subscriptionId, key) =>
        apim.DeleteContentType({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          contentTypeId: key.contentTypeName,
        }),
      inSync: (news, observed) =>
        observed.properties?.name === (news.displayName ?? observed.name) &&
        (news.description === undefined || observed.properties?.description === news.description) &&
        (news.version === undefined || observed.properties?.version === news.version) &&
        subsetMatches(news.schema, observed.properties?.schema),
      // Built-in content types cannot be changed or removed.
      isSystem: (observed) => !(observed.name ?? "").startsWith("c-"),
      toAttrs: (_subscriptionId, key, observed) => ({
        resourceGroup: key.resourceGroup,
        serviceName: key.serviceName,
        contentTypeName: key.contentTypeName,
        contentTypeId: observed.id ?? "",
        displayName: observed.properties?.name ?? key.contentTypeName,
      }),
    }),
  });
