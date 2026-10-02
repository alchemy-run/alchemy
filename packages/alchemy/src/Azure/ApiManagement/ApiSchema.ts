import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createEntityName } from "./Common.ts";
import { entityLifecycle } from "./Entity.ts";

export interface ApiSchemaProps {
  /** Resource group of the API Management service. Changing it replaces the schema. */
  resourceGroup: string;
  /** API Management service that holds the API. Changing it replaces the schema. */
  serviceName: string;
  /** Identifier of the API the schema belongs to. Changing it replaces the schema. */
  apiName: string;
  /**
   * Schema identifier, unique within the API. Changing it replaces the
   * schema.
   * @default a name generated from the stack, stage, and logical ID
   */
  name?: string;
  /**
   * Media type of the document, e.g.
   * `application/vnd.oai.openapi.components+json` (OpenAPI components),
   * `application/vnd.ms-azure-apim.swagger.definitions+json` (Swagger
   * definitions), `application/vnd.ms-azure-apim.xsd+xml` (XSD), or
   * `application/vnd.ms-azure-apim.graphql.schema` (GraphQL SDL).
   */
  contentType: string;
  /** Schema document as a string (XSD, GraphQL SDL, or JSON text). */
  value?: string;
  /** Swagger `definitions` object (Swagger content types). */
  definitions?: Record<string, unknown>;
  /** OpenAPI `components` object (OpenAPI content types). */
  components?: Record<string, unknown>;
}

export interface ApiSchema extends Resource<
  "Azure.ApiManagement.ApiSchema",
  ApiSchemaProps,
  {
    /** Schema identifier within the API. */
    schemaName: string;
    /** ARM resource ID of the schema. */
    schemaId: string;
    /** Identifier of the API the schema belongs to. */
    apiName: string;
    /** API Management service that holds the API. */
    serviceName: string;
    /** Resource group of the service. */
    resourceGroup: string;
    /** Media type of the schema document. */
    contentType: string;
  },
  never,
  Providers
> {}

/**
 * A schema document (OpenAPI components, Swagger definitions, XSD, or
 * GraphQL SDL) attached to an API in API Management. Operations reference
 * its types for request/response validation and the developer portal.
 *
 * @see https://learn.microsoft.com/rest/api/apimanagement/api-schema
 *
 * ### Attaching Schemas
 * **Example:** OpenAPI components for request validation
 * ```typescript
 * yield* Azure.ApiManagement.ApiSchema("orders-schema", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   apiName: api.apiName,
 *   contentType: "application/vnd.oai.openapi.components+json",
 *   components: {
 *     schemas: {
 *       Order: { type: "object", properties: { id: { type: "integer" } } },
 *     },
 *   },
 * });
 * ```
 *
 * **Example:** XSD for a SOAP API
 * ```typescript
 * yield* Azure.ApiManagement.ApiSchema("soap-schema", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   apiName: soapApi.apiName,
 *   contentType: "application/vnd.ms-azure-apim.xsd+xml",
 *   value: xsdDocument,
 * });
 * ```
 *
 * @resource
 */
export const ApiSchema = Resource<ApiSchema>("Azure.ApiManagement.ApiSchema");

interface Key {
  resourceGroup: string;
  serviceName: string;
  apiName: string;
  schemaName: string;
}

const json = (value: unknown) =>
  value === undefined ? undefined : JSON.stringify(value);

export const ApiSchemaProvider = () =>
  Provider.succeed(ApiSchema, {
    stables: [
      "schemaName",
      "schemaId",
      "apiName",
      "serviceName",
      "resourceGroup",
    ],
    ...entityLifecycle<
      ApiSchemaProps,
      ApiSchema["Attributes"],
      Key,
      apim.GetApiSchemaResponse
    >({
      label: (key) =>
        `API Management schema ${key.schemaName} of API ${key.apiName}`,
      keyOf: (props, id, output) =>
        Effect.gen(function* () {
          return {
            resourceGroup: props.resourceGroup,
            serviceName: props.serviceName,
            apiName: props.apiName,
            schemaName:
              props.name ?? output?.schemaName ?? (yield* createEntityName(id)),
          };
        }),
      keyOfAttrs: (attrs) => attrs,
      get: (subscriptionId, key) =>
        apim.GetApiSchema({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          apiId: key.apiName,
          schemaId: key.schemaName,
        }),
      put: (subscriptionId, key, news) =>
        apim.ApiSchemaCreateOrUpdate({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          apiId: key.apiName,
          schemaId: key.schemaName,
          properties: {
            contentType: news.contentType,
            document: {
              value: news.value,
              definitions: news.definitions,
              components: news.components,
            },
          },
        }),
      remove: (subscriptionId, key) =>
        apim.DeleteApiSchema({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          apiId: key.apiName,
          schemaId: key.schemaName,
        }),
      inSync: (news, observed) => {
        const props = observed.properties;
        return (
          props?.contentType === news.contentType &&
          (news.value === undefined || props.document?.value === news.value) &&
          (news.definitions === undefined ||
            json(props.document?.definitions) === json(news.definitions)) &&
          (news.components === undefined ||
            json(props.document?.components) === json(news.components))
        );
      },
      stateOf: (observed) => observed.properties?.provisioningState,
      toAttrs: (_subscriptionId, key, observed) => ({
        resourceGroup: key.resourceGroup,
        serviceName: key.serviceName,
        apiName: key.apiName,
        schemaName: key.schemaName,
        schemaId: observed.id ?? "",
        contentType: observed.properties?.contentType ?? "",
      }),
    }),
  });
