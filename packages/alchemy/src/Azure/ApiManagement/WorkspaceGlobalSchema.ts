import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createEntityName } from "./Common.ts";
import { entityLifecycle } from "./Entity.ts";

export interface WorkspaceGlobalSchemaProps {
  /** Resource group of the API Management service. Changing it replaces the schema. */
  resourceGroup: string;
  /** API Management service that holds the schema. Changing it replaces the schema. */
  serviceName: string;
  /** Workspace that holds the entity (`Workspace.workspaceName`). Changing it replaces the entity. */
  workspaceName: string;
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

export interface WorkspaceGlobalSchema extends Resource<
  "Azure.ApiManagement.WorkspaceGlobalSchema",
  WorkspaceGlobalSchemaProps,
  {
    /** Schema identifier within the service. */
    schemaName: string;
    /** ARM resource ID of the schema. */
    schemaId: string;
    /** API Management service that holds the schema. */
    serviceName: string;
    /** Workspace that holds the entity. */
    workspaceName: string;
    /** Resource group of the service. */
    resourceGroup: string;
    /** Schema language. */
    schemaType: string;
  },
  never,
  Providers
> {}

/**
 * The workspace-scoped counterpart of {@link GlobalSchema}: the same entity inside
 * an API Management {@link Workspace} (Premium and v2 tiers).
 *
 * A service-wide schema (JSON Schema or XSD) of an API Management service.
 * The `validate-content` policy references it by identifier to validate
 * request and response bodies of any API.
 *
 * @see https://learn.microsoft.com/azure/api-management/validate-content-policy
 *
 * ### Validating Payloads
 * **Example:** A JSON Schema for order payloads
 * ```typescript
 * const schema = yield* Azure.ApiManagement.WorkspaceGlobalSchema("order", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   workspaceName: workspace.workspaceName,
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
export const WorkspaceGlobalSchema = Resource<WorkspaceGlobalSchema>(
  "Azure.ApiManagement.WorkspaceGlobalSchema",
);

interface Key {
  resourceGroup: string;
  serviceName: string;
  workspaceName: string;
  schemaName: string;
}

const json = (value: unknown) =>
  value === undefined ? undefined : JSON.stringify(value);

export const WorkspaceGlobalSchemaProvider = () =>
  Provider.succeed(WorkspaceGlobalSchema, {
    stables: [
      "schemaName",
      "schemaId",
      "serviceName",
      "workspaceName",
      "resourceGroup",
    ],
    ...entityLifecycle<
      WorkspaceGlobalSchemaProps,
      WorkspaceGlobalSchema["Attributes"],
      Key,
      apim.GetWorkspaceGlobalSchemaResponse
    >({
      label: (key) => `API Management schema ${key.schemaName}`,
      keyOf: (props, id, output) =>
        Effect.gen(function* () {
          return {
            resourceGroup: props.resourceGroup,
            serviceName: props.serviceName,
            workspaceName: props.workspaceName,
            schemaName:
              props.name ?? output?.schemaName ?? (yield* createEntityName(id)),
          };
        }),
      keyOfAttrs: (attrs) => attrs,
      get: (subscriptionId, key) =>
        apim.GetWorkspaceGlobalSchema({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          workspaceId: key.workspaceName,
          schemaId: key.schemaName,
        }),
      put: (subscriptionId, key, news) =>
        apim.WorkspaceGlobalSchemaCreateOrUpdate({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          workspaceId: key.workspaceName,
          schemaId: key.schemaName,
          properties: {
            schemaType: news.schemaType,
            description: news.description,
            value: news.value,
            document: news.document,
          },
        }),
      remove: (subscriptionId, key) =>
        apim.DeleteWorkspaceGlobalSchema({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          workspaceId: key.workspaceName,
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
        workspaceName: key.workspaceName,
        schemaName: key.schemaName,
        schemaId: observed.id ?? "",
        schemaType: observed.properties?.schemaType ?? "",
      }),
    }),
  });
