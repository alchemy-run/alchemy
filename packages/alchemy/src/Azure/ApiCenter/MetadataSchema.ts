import * as apicenter from "@distilled.cloud/azure/apicenter";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import {
  createApiCenterName,
  entityLifecycle,
  subsetMatches,
} from "./Common.ts";

export type ApiCenterMetadataEntity = "api" | "environment" | "deployment";

export interface ApiCenterMetadataAssignment {
  /** Catalog entity kind the schema applies to. */
  entity: ApiCenterMetadataEntity;
  /**
   * Whether entities of this kind must set the property.
   * @default false
   */
  required?: boolean;
  /**
   * Whether the property is deprecated for entities of this kind.
   * @default false
   */
  deprecated?: boolean;
}

export interface MetadataSchemaProps {
  /** Resource group of the API Center service. Changing it replaces the schema. */
  resourceGroup: string;
  /** API Center service that holds the schema. Changing it replaces the schema. */
  serviceName: string;
  /**
   * Schema name: 3-90 letters, digits, and hyphens. It is the key used in
   * `customProperties` of APIs, environments, and deployments. If omitted,
   * a unique name is generated from the app, stage, and logical ID.
   * Changing it replaces the schema.
   */
  name?: string;
  /**
   * JSON Schema describing the custom property, either as a JSON string or
   * as an object (serialized for you), e.g. `{ type: "string" }`.
   */
  schema: string | Record<string, unknown>;
  /**
   * Catalog entities the schema is assigned to.
   * @default not assigned to any entity
   */
  assignedTo?: ApiCenterMetadataAssignment[];
}

export interface MetadataSchema extends Resource<
  "Azure.ApiCenter.MetadataSchema",
  MetadataSchemaProps,
  {
    /** Name of the schema (the `customProperties` key). */
    metadataSchemaName: string;
    /** API Center service that holds the schema. */
    serviceName: string;
    /** Resource group of the service. */
    resourceGroup: string;
    /** ARM resource ID of the schema. */
    metadataSchemaId: string;
    /** JSON Schema as stored by API Center. */
    schema: string;
  },
  never,
  Providers
> {}

/**
 * A custom metadata schema in Azure API Center. Assigned schemas define
 * the `customProperties` that APIs, environments, and deployments carry.
 *
 * @see https://learn.microsoft.com/azure/api-center/metadata
 *
 * ### Defining Metadata
 * **Example:** String property required on every API
 * ```typescript
 * const team = yield* Azure.ApiCenter.MetadataSchema("team", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: center.serviceName,
 *   name: "team",
 *   schema: { type: "string", title: "Owning team" },
 *   assignedTo: [{ entity: "api", required: true }],
 * });
 * ```
 *
 * **Example:** Enumerated property for environments
 * ```typescript
 * const tier = yield* Azure.ApiCenter.MetadataSchema("tier", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: center.serviceName,
 *   schema: { type: "string", enum: ["gold", "silver"] },
 *   assignedTo: [{ entity: "environment" }],
 * });
 * ```
 *
 * @resource
 */
export const MetadataSchema = Resource<MetadataSchema>(
  "Azure.ApiCenter.MetadataSchema",
);

interface Key {
  resourceGroup: string;
  serviceName: string;
  metadataSchemaName: string;
}

const schemaString = (schema: string | Record<string, unknown>) =>
  typeof schema === "string" ? schema : JSON.stringify(schema);

const parseOr = (value: string | undefined): unknown => {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

/** Structural equality of two JSON values (object key order ignored). */
const jsonEquals = (a: unknown, b: unknown): boolean =>
  subsetMatches(a, b) && subsetMatches(b, a);

const assignments = (props: MetadataSchemaProps) =>
  (props.assignedTo ?? []).map((a) => ({
    entity: a.entity,
    required: a.required ?? false,
    deprecated: a.deprecated ?? false,
  }));

export const MetadataSchemaProvider = () =>
  Provider.succeed(MetadataSchema, {
    stables: [
      "metadataSchemaName",
      "serviceName",
      "resourceGroup",
      "metadataSchemaId",
    ],
    ...entityLifecycle<
      MetadataSchemaProps,
      MetadataSchema["Attributes"],
      Key,
      apicenter.GetMetadataSchemaResponse
    >({
      label: (key) => `API Center metadata schema ${key.metadataSchemaName}`,
      keyOf: (props, id, output) =>
        Effect.gen(function* () {
          return {
            resourceGroup: props.resourceGroup,
            serviceName: props.serviceName,
            metadataSchemaName:
              props.name ??
              output?.metadataSchemaName ??
              (yield* createApiCenterName(id)),
          };
        }),
      keyOfAttrs: (attrs) => attrs,
      get: (subscriptionId, key) =>
        apicenter.GetMetadataSchema({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          metadataSchemaName: key.metadataSchemaName,
        }),
      put: (subscriptionId, key, props) =>
        apicenter.MetadataSchemasCreateOrUpdate({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          metadataSchemaName: key.metadataSchemaName,
          properties: {
            schema: schemaString(props.schema),
            assignedTo: assignments(props),
          },
        }),
      remove: (subscriptionId, key) =>
        apicenter.DeleteMetadataSchema({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          metadataSchemaName: key.metadataSchemaName,
        }),
      inSync: (props, observed) => {
        const observedAssignments = (observed.properties?.assignedTo ?? []).map(
          (a) => ({
            entity: a.entity,
            required: a.required ?? false,
            deprecated: a.deprecated ?? false,
          }),
        );
        return (
          jsonEquals(
            parseOr(schemaString(props.schema)),
            parseOr(observed.properties?.schema),
          ) && jsonEquals(assignments(props), observedAssignments)
        );
      },
      toAttrs: (_subscriptionId, key, observed) => ({
        resourceGroup: key.resourceGroup,
        serviceName: key.serviceName,
        metadataSchemaName: key.metadataSchemaName,
        metadataSchemaId: observed.id ?? "",
        schema: observed.properties?.schema ?? "",
      }),
    }),
  });
