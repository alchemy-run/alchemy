import type { OpenAPIV3 } from "openapi-types";
import * as yaml from "yaml";
import type { Context } from "../context.ts";
import { Resource } from "../resource.ts";
import { CloudflareApiError, handleApiError } from "./api-error.ts";
import {
  createCloudflareApi,
  type CloudflareApi,
  type CloudflareApiOptions,
} from "./api.ts";
import type { Zone } from "./zone.ts";
import { findZoneForHostname } from "./zone.ts";

/**
 * Schema format type
 */
export type SchemaKind = "openapi_v3";

/**
 * Properties for creating or updating a Schema
 */
export interface SchemaProps<S extends OpenAPIV3.Document>
  extends CloudflareApiOptions {
  /**
   * The zone to upload the schema to
   */
  zone: string | Zone;

  /**
   * OpenAPI v3.0.x schema content (YAML string, JSON string, or OpenAPI object)
   * Provide either this or schemaFile
   *
   * Note: Cloudflare only supports OpenAPI v3.0.x, not v3.1
   */
  schema: S;

  /**
   * Name for the schema
   * @default resource id
   */
  name?: string;

  /**
   * Schema format
   * @default "openapi_v3"
   */
  kind?: SchemaKind;

  /**
   * Enable validation immediately after upload
   *
   * Warning: will trigger a replace when disabling validation.
   *
   * @default true
   */
  enabled?: boolean;
}

/**
 * Schema output
 */
export interface Schema<S extends OpenAPIV3.Document = OpenAPIV3.Document>
  extends Resource<"cloudflare::Schema"> {
  /**
   * Schema ID
   */
  id: string;

  /**
   * Name for the schema
   */
  name: string;

  /**
   * The API Schema
   */
  schema: S;

  /**
   * Schema kind/format
   */
  kind: SchemaKind;

  /**
   * Source of the schema
   */
  source: string;

  /**
   * Whether validation is enabled
   */
  enabled: boolean;
}

/**
 * Cloudflare API Gateway Schema manages OpenAPI v3 schemas for API validation.
 *
 * @example
 * ## Basic schema upload with inline YAML
 *
 * const apiSchema = await Schema("my-api-schema", {
 *   zone: myZone,
 *   name: "my-api-v1"
 *   schema: `
 *     openapi: 3.0.0
 *     info:
 *       title: My API
 *       version: 1.0.0
 *     servers:
 *       - url: https://api.example.com
 *     paths:
 *       /users:
 *         get:
 *           operationId: getUsers
 *           responses:
 *             '200':
 *               description: Success
 *   `,
 * });
 *
 * @example
 * ## Schema upload from file
 *
 * const fileSchema = await Schema("api-schema-from-file", {
 *   zone: "example.com",
 *   schemaFile: "./openapi.yaml",
 *   name: "production-api-v2",
 *   enabled: false  // Upload but don't enable validation yet
 * });
 *
 * @example
 * ## Schema with typed OpenAPI object
 *
 * import type { OpenAPIV3 } from "openapi-types";
 *
 * const typedSchema: OpenAPIV3.Document = {
 *   openapi: "3.0.0",
 *   info: { title: "Typed API", version: "1.0.0" },
 *   paths: {
 *     "/health": {
 *       get: {
 *         operationId: "healthCheck",
 *         responses: { "200": { description: "OK" } }
 *       }
 *     }
 *   }
 * };
 *
 * const schema = await Schema("typed-schema", {
 *   zone: myZone,
 *   schema: typedSchema
 * });
 */
export const Schema = Resource("cloudflare::Schema", async function <
  S extends OpenAPIV3.Document,
>(this: Context<Schema<S>>, id: string, props: SchemaProps<S>): Promise<
  Schema<S>
> {
  const api = await createCloudflareApi(props);

  // Resolve zone ID and name
  const zoneId =
    typeof props.zone === "string"
      ? (await findZoneForHostname(api, props.zone)).zoneId
      : props.zone.id;

  if (this.phase === "delete") {
    if (this.output?.id) {
      await deleteSchema(api, zoneId, this.output.id);
    }
    return this.destroy();
  }

  // Load schema content
  const parsedSchema = props.schema;

  let schemaDetails: CloudflareSchemaDetails;

  if (this.phase === "update" && this.output?.id) {
    // Check if we need to replace due to name, schema content change, or disabling validation
    if (
      props.name !== this.output.name ||
      JSON.stringify(parsedSchema) !== JSON.stringify(this.output.schema) ||
      (this.output.enabled === true && props.enabled === false)
    ) {
      // Name, schema content changed, or trying to disable validation - need to replace
      this.replace();
    }

    // Update existing schema (can only update validation_enabled)
    schemaDetails = await updateSchema(api, zoneId, this.output.id, {
      validation_enabled: props.enabled !== false,
    });
  } else {
    // Create new schema
    schemaDetails = await uploadSchema(api, zoneId, {
      file: yaml.stringify(parsedSchema),
      name: props.name || id,
      kind: props.kind || "openapi_v3",
      validation_enabled: props.enabled !== false,
    });
  }

  return this({
    id: schemaDetails.id,
    name: schemaDetails.name,
    schema: parsedSchema as any,
    kind: schemaDetails.kind,
    source: schemaDetails.source,
    enabled: schemaDetails.validationEnabled,
  });
});

// API helper functions

interface CloudflareSchemaDetails {
  id: string;
  name: string;
  kind: SchemaKind;
  source: string;
  validationEnabled: boolean;
  createdAt: string;
}

interface CloudflareSchema {
  schema_id: string;
  name: string;
  kind: string;
  source: string;
  validation_enabled: boolean;
  created_at: string;
  size?: number;
  is_learned?: boolean;
}

async function uploadSchema(
  api: CloudflareApi,
  zoneId: string,
  params: {
    file: string;
    name: string;
    kind: SchemaKind;
    validation_enabled?: boolean;
  },
): Promise<CloudflareSchemaDetails> {
  const body = {
    source: params.file,
    name: params.name,
    kind: params.kind,
    validation_enabled: params.validation_enabled ?? true,
  };

  const response = await api.post(
    `/zones/${zoneId}/schema_validation/schemas`,
    body,
  );

  if (!response.ok) {
    await handleApiError(response, "uploading", "schema", params.name);
  }

  const data = (await response.json()) as {
    result: CloudflareSchema;
  };
  console.log("create schema", data.result.schema_id);
  return {
    id: data.result.schema_id,
    name: data.result.name,
    kind: data.result.kind as SchemaKind,
    source: data.result.source,
    validationEnabled: data.result.validation_enabled,
    createdAt: data.result.created_at,
  };
}

async function updateSchema(
  api: CloudflareApi,
  zoneId: string,
  schemaId: string,
  params: {
    validation_enabled: boolean;
  },
): Promise<CloudflareSchemaDetails> {
  console.log("update", schemaId);
  const response = await api.patch(
    `/zones/${zoneId}/schema_validation/schemas/${schemaId}`,
    params,
  );

  if (!response.ok) {
    await handleApiError(response, "updating", "schema", schemaId);
  }

  const data = (await response.json()) as { result: CloudflareSchema };
  return {
    id: data.result.schema_id,
    name: data.result.name,
    kind: data.result.kind as SchemaKind,
    source: data.result.source,
    validationEnabled: data.result.validation_enabled,
    createdAt: data.result.created_at,
  };
}

async function deleteSchema(
  api: CloudflareApi,
  zoneId: string,
  schemaId: string,
): Promise<void> {
  console.log("delete", schemaId);
  const response = await api.delete(
    `/zones/${zoneId}/schema_validation/schemas/${schemaId}`,
  );
  const data = (await response.json()) as {
    success: boolean;
    errors: {
      code: number;
      message: string;
    }[];
  };
  console.log("deleteSchema response", response.status, data);

  if (!response.ok && response.status !== 404) {
    await handleApiError(response, "deleting", "schema", schemaId);
  } else if (!data.success) {
    throw new CloudflareApiError(data.errors[0].message, response);
  }
}

/**
 * Get schema details
 */
export async function getSchema(
  api: CloudflareApi,
  zoneId: string,
  schemaId: string,
): Promise<CloudflareSchemaDetails | null> {
  const response = await api.get(
    `/zones/${zoneId}/schema_validation/schemas/${schemaId}`,
  );

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    await handleApiError(response, "getting", "schema", schemaId);
  }

  const data = (await response.json()) as { result: CloudflareSchema };
  return {
    id: data.result.schema_id,
    name: data.result.name,
    kind: data.result.kind as SchemaKind,
    source: data.result.source,
    validationEnabled: data.result.validation_enabled,
    createdAt: data.result.created_at,
  };
}
