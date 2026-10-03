import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createEntityName } from "./Common.ts";
import { entityLifecycle } from "./Entity.ts";

export interface GlobalSchemaProps {
  /** Resource group of the API Management service. Changing it replaces the schema. */
  resourceGroup: string;
  /** API Management service that holds the schema. Changing it replaces the schema. */
  serviceName: string;
  /**
   * Schema identifier, unique within the service. Changing it replaces the
   * schema.
   * @default a name generated from the stack, stage, and logical ID
   */
  name?: string;
  /** Schema language: `json` (JSON Schema) or `xml` (XSD). */
  schemaType: "json" | "xml";
  /** Description of the schema. */
  description?: string;
  /** XSD document (when `schemaType` is `xml`). */
  value?: string;
  /** JSON Schema document (when `schemaType` is `json`). */
  document?: Record<string, unknown>;
}

export interface GlobalSchema extends Resource<
  "Azure.ApiManagement.GlobalSchema",
  GlobalSchemaProps,
  {
    /** Schema identifier within the service. */
    schemaName: string;
    /** ARM resource ID of the schema. */
    schemaId: string;
    /** API Management service that holds the schema. */
    serviceName: string;
    /** Resource group of the service. */
    resourceGroup: string;
    /** Schema language. */
    schemaType: string;
  },
  never,
  Providers
> {}

/**
 * A service-wide schema (JSON Schema or XSD) of an API Management service.
 * The `validate-content` policy references it by identifier to validate
 * request and response bodies of any API.
 *
 * @see https://learn.microsoft.com/azure/api-management/validate-content-policy
 *
 * ### Validating Payloads
 * **Example:** A JSON Schema for order payloads
 * ```typescript
 * const schema = yield* Azure.ApiManagement.GlobalSchema("order", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   schemaType: "json",
 *   description: "Order payload",
 *   document: {
 *     type: "object",
 *     required: ["id"],
 *     properties: { id: { type: "integer" } },
 *   },
 * });
 * ```
 *
 * @resource
 */
export const GlobalSchema = Resource<GlobalSchema>(
  "Azure.ApiManagement.GlobalSchema",
);

interface Key {
  resourceGroup: string;
  serviceName: string;
  schemaName: string;
}

const json = (value: unknown) =>
  value === undefined ? undefined : JSON.stringify(value);

export const GlobalSchemaProvider = () =>
  Provider.succeed(GlobalSchema, {
    stables: ["schemaName", "schemaId", "serviceName", "resourceGroup"],
    ...entityLifecycle<
      GlobalSchemaProps,
      GlobalSchema["Attributes"],
      Key,
      apim.GetGlobalSchemaResponse
    >({
      label: (key) => `API Management schema ${key.schemaName}`,
      keyOf: (props, id, output) =>
        Effect.gen(function* () {
          return {
            resourceGroup: props.resourceGroup,
            serviceName: props.serviceName,
            schemaName:
              props.name ?? output?.schemaName ?? (yield* createEntityName(id)),
          };
        }),
      keyOfAttrs: (attrs) => attrs,
      get: (subscriptionId, key) =>
        apim.GetGlobalSchema({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          schemaId: key.schemaName,
        }),
      put: (subscriptionId, key, news) =>
        apim.GlobalSchemaCreateOrUpdate({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          schemaId: key.schemaName,
          properties: {
            schemaType: news.schemaType,
            description: news.description,
            value: news.value,
            document: news.document,
          },
        }),
      remove: (subscriptionId, key) =>
        apim.DeleteGlobalSchema({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          schemaId: key.schemaName,
        }),
      inSync: (news, observed) => {
        const props = observed.properties;
        return (
          props?.schemaType === news.schemaType &&
          (news.description === undefined ||
            props.description === news.description) &&
          (news.value === undefined || props.value === news.value) &&
          (news.document === undefined ||
            json(props.document) === json(news.document))
        );
      },
      stateOf: (observed) => observed.properties?.provisioningState,
      toAttrs: (_subscriptionId, key, observed) => ({
        resourceGroup: key.resourceGroup,
        serviceName: key.serviceName,
        schemaName: key.schemaName,
        schemaId: observed.id ?? "",
        schemaType: observed.properties?.schemaType ?? "",
      }),
    }),
  });
