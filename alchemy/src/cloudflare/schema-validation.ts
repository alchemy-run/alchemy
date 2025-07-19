import { readFile } from "node:fs/promises";
import type { OpenAPIV3 } from "openapi-types";
import * as yaml from "yaml";
import type { Context } from "../context.ts";
import { Resource } from "../resource.ts";
import { handleApiError } from "./api-error.ts";
import { ApiGatewayOperation } from "./api-gateway-operation.ts";
import {
  createCloudflareApi,
  type CloudflareApi,
  type CloudflareApiOptions,
} from "./api.ts";
import type { Zone } from "./zone.ts";

/**
 * Validation action to take when requests don't match the schema
 */
export type ValidationAction = "none" | "log" | "block";

/**
 * HTTP methods supported by OpenAPI
 */
export type HTTPMethod =
  | "get"
  | "post"
  | "put"
  | "patch"
  | "delete"
  | "head"
  | "options"
  | "trace";

/**
 * Schema format type
 */
export type SchemaKind = "openapi_v3";

/**
 * Operation validation setting
 */
export interface OperationValidation {
  /**
   * The operation ID from the schema
   */
  operationId: string;

  /**
   * The HTTP method (GET, POST, etc.)
   */
  method: string;

  /**
   * The host
   */
  host: string;

  /**
   * The endpoint path
   */
  endpoint: string;

  /**
   * Validation action for this operation
   */
  action: ValidationAction;
}

/**
 * Properties for creating or updating Schema Validation
 */
export interface SchemaValidationProps extends CloudflareApiOptions {
  /**
   * The zone to configure schema validation for
   *
   * @example
   * await SchemaValidation("my-zone", {
   *   zone: "my-zone.com",
   *   schema: `
   *     openapi: 3.0.0
   *     info:
   *       title: My API
   *       version: 1.0.0
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
   * const zone = await Zone("my-zone", {
   *   name: "my-zone.com",
   *   type: "full",
   *   delete: true,
   * });
   *
   * await SchemaValidation("my-zone", {
   *   zone: zone,
   *   schema: `
   *     openapi: 3.0.0
   *     info:
   *       title: My API
   *       version: 1.0.0
   *     paths:
   *       /users:
   *         get:
   *           operationId: getUsers
   *           responses:
   *             '200':
   *               description: Success
   *   `,
   */
  zone: string | Zone;

  /**
   * OpenAPI v3.0.x schema content (YAML string, JSON string, or OpenAPI object)
   * Provide either this or schemaFile
   *
   * Note: Cloudflare only supports OpenAPI v3.0.x, not v3.1
   */
  schema?: string | OpenAPIV3.Document;

  /**
   * Path to OpenAPI v3 schema file
   * Provide either this or schema
   */
  schemaFile?: string;

  /**
   * Name for the schema
   * @default "api-schema"
   */
  name?: string;

  /**
   * Schema format
   * @default "openapi_v3"
   */
  kind?: SchemaKind;

  /**
   * Enable validation immediately after upload
   * @default true
   */
  enableValidation?: boolean;

  /**
   * Default validation action for all operations
   * @default "none"
   */
  defaultAction?: ValidationAction;

  /**
   * Per-operation validation overrides using OpenAPI-style path structure
   *
   * Can specify actions per HTTP method or a blanket action for all methods on a path:
   *
   * @example
   * // Per-method configuration
   * {
   *   "/users": {
   *     get: "none",
   *     post: "block"
   *   },
   *   "/users/{id}": {
   *     delete: "block"
   *   }
   * }
   *
   * @example
   * // Blanket action for all methods on a path
   * {
   *   "/users": "none",
   *   "/users/{id}": "block",
   *   "/admin": "block"
   * }
   */
  actions?: Record<
    string,
    ValidationAction | Partial<Record<HTTPMethod, ValidationAction>>
  >;

  /**
   * Action for requests that don't match any operation
   * @default "none"
   */
  unknownOperationAction?: ValidationAction;
}

/**
 * Schema details
 */
export interface SchemaDetails {
  /**
   * Schema ID
   */
  id: string;

  /**
   * Schema name
   */
  name: string;

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
  validationEnabled: boolean;

  /**
   * When the schema was created
   */
  createdAt: string;
}

/**
 * Global validation settings
 */
export interface ValidationSettings {
  /**
   * Default mitigation action
   */
  defaultMitigationAction: ValidationAction;

  /**
   * Override mitigation action for specific operations
   */
  overrideMitigationAction?: ValidationAction;
}

/**
 * Schema Validation output
 */
export interface SchemaValidation
  extends Resource<"cloudflare::SchemaValidation"> {
  /**
   * Zone ID
   */
  zoneId: string;

  /**
   * Zone name
   */
  zoneName: string;

  /**
   * Uploaded schema details
   */
  schema: SchemaDetails;

  /**
   * Global validation settings
   */
  settings: ValidationSettings;

  /**
   * Per-operation validation settings
   */
  operations: OperationValidation[];
}

/**
 * Cloudflare Schema Validation protects your API endpoints by validating incoming requests
 * against an OpenAPI v3 schema. It can log or block requests that don't match your schema,
 * helping prevent malformed requests and potential security issues.
 *
 * @example
 * ## Basic schema validation with inline YAML
 *
 * Enable schema validation with a simple OpenAPI schema as YAML string
 *
 * const validation = await SchemaValidation("api-validation", {
 *   zone: myZone,
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
 *       /users/{id}:
 *         get:
 *           operationId: getUser
 *           parameters:
 *             - name: id
 *               in: path
 *               required: true
 *               schema:
 *                 type: string
 *   `,
 *   defaultAction: "none"
 * });
 *
 * @example
 * ## Schema validation with typed OpenAPI object
 *
 * Use strongly-typed OpenAPI v3 objects for better IDE support
 *
 * import type { OpenAPIV3 } from "openapi-types";
 *
 * const apiSchema: OpenAPIV3.Document = {
 *   openapi: "3.0.0",
 *   info: {
 *     title: "My API",
 *     version: "1.0.0",
 *   },
 *   servers: [
 *     { url: "https://api.example.com" }
 *   ],
 *   paths: {
 *     "/users": {
 *       get: {
 *         operationId: "getUsers",
 *         responses: {
 *           "200": {
 *             description: "Success",
 *             content: {
 *               "application/json": {
 *                 schema: {
 *                   type: "array",
 *                   items: {
 *                     type: "object",
 *                     properties: {
 *                       id: { type: "string" },
 *                       name: { type: "string" }
 *                     }
 *                   }
 *                 }
 *               }
 *             }
 *           }
 *         }
 *       }
 *     }
 *   }
 * };
 *
 * const validation = await SchemaValidation("api-validation", {
 *   zone: myZone,
 *   schema: apiSchema,
 *   defaultAction: "none"
 * });
 *
 * @example
 * ## Schema validation with file
 *
 * Load schema from an external file with custom settings
 *
 * const validation = await SchemaValidation("api-validation", {
 *   zone: "example.com",
 *   schemaFile: "./openapi.yaml",
 *   name: "production-api-v2",
 *   defaultAction: "none",
 *   actions: {
 *     "/users": {
 *       get: "none",        // No action for read operations
 *       post: "log",        // Log violations for writes (requires paid plan)
 *     },
 *     "/users/{id}": {
 *       delete: "block"     // Block destructive operations (requires paid plan)
 *     }
 *   },
 *   unknownOperationAction: "none"
 * });
 *
 * @example
 * ## Monitor API traffic without impact
 *
 * Use validation in monitoring mode to understand traffic patterns
 *
 * const monitoring = await SchemaValidation("api-monitoring", {
 *   zone: myZone,
 *   schemaFile: "./api-schema.json",
 *   defaultAction: "none",
 *   enableValidation: true
 * });
 *
 * @example
 * ## Log schema violations
 *
 * Track non-compliant requests without blocking (requires paid plan)
 *
 * const withLogging = await SchemaValidation("api-logging", {
 *   zone: myZone,
 *   schemaFile: "./api-schema.json",
 *   defaultAction: "log",
 *   enableValidation: true
 * });
 *
 * @example
 * ## Protect critical endpoints with blanket actions
 *
 * Apply actions to entire paths or specific methods (requires paid plan)
 *
 * const protection = await SchemaValidation("api-protection", {
 *   zone: myZone,
 *   schemaFile: "./api-schema.json",
 *   defaultAction: "log",
 *   actions: {
 *     "/admin": "block",              // Block all methods on admin endpoints
 *     "/payments": {
 *       post: "block",                // Block payment creation
 *       put: "block"                  // Block payment updates
 *     },
 *     "/users/{id}": {
 *       delete: "block"               // Block user deletion
 *     },
 *     "/public": "none",              // Allow all methods on public endpoints
 *     "/products": "none"             // Allow all methods on products
 *   }
 * });
 *
 * @example
 * ## Disable validation temporarily
 *
 * Disable validation during maintenance or troubleshooting
 *
 * const validation = await SchemaValidation("api-validation", {
 *   zone: myZone,
 *   schemaFile: "./openapi.yaml",
 *   enableValidation: false,  // Upload schema but don't validate
 *   defaultAction: "none"
 * });
 *
 * @see https://developers.cloudflare.com/api-shield/security/schema-validation/
 */
export const SchemaValidation = Resource(
  "cloudflare::SchemaValidation",
  async function (
    this: Context<SchemaValidation>,
    _id: string,
    props: SchemaValidationProps,
  ): Promise<SchemaValidation> {
    const api = await createCloudflareApi(props);

    // Resolve zone ID
    const zoneId = typeof props.zone === "string" ? props.zone : props.zone.id;
    const zoneName =
      typeof props.zone === "string" ? props.zone : props.zone.name;

    if (this.phase === "delete") {
      if (this.output?.schema?.id) {
        // Delete the schema
        await deleteSchema(api, zoneId, this.output.schema.id);

        // Reset settings to default
        await updateGlobalSettings(api, zoneId, {
          validation_default_mitigation_action: "none",
        });
      }
      return this.destroy();
    }

    // Check if schema already exists
    let schemaDetails: SchemaDetails | undefined;
    if (this.output?.schema?.id) {
      try {
        const existing = await getSchema(api, zoneId, this.output.schema.id);
        if (existing) {
          schemaDetails = existing;
        }
      } catch {
        // Schema doesn't exist anymore, will create new one
      }
    }

    // Load schema content if we need to create/update
    let schemaContent: string | undefined;
    if (!schemaDetails) {
      if (props.schema) {
        // Handle different schema input types
        if (typeof props.schema === "string") {
          schemaContent = props.schema;
        } else {
          // Convert OpenAPI object to YAML string
          schemaContent = yaml.stringify(props.schema);
        }
      } else if (props.schemaFile) {
        schemaContent = await readFile(props.schemaFile, "utf-8");
      } else {
        throw new Error("Either 'schema' or 'schemaFile' must be provided");
      }
    }

    // Upload or update schema
    if (!schemaDetails && schemaContent) {
      // Create new schema
      const uploaded = await uploadSchema(api, zoneId, {
        file: schemaContent,
        name: props.name || "api-schema",
        kind: props.kind || "openapi_v3",
        validation_enabled: props.enableValidation !== false,
      });
      schemaDetails = uploaded;
    } else if (schemaDetails) {
      // Update validation status if needed
      if (
        (props.enableValidation !== false &&
          !schemaDetails.validationEnabled) ||
        (props.enableValidation === false && schemaDetails.validationEnabled)
      ) {
        schemaDetails = await updateSchema(api, zoneId, schemaDetails.id, {
          validation_enabled: props.enableValidation !== false,
        });
      }
    }

    if (!schemaDetails) {
      throw new Error("Failed to create or find schema");
    }

    // Update global settings
    const defaultAction = props.defaultAction || "none";
    await updateGlobalSettings(api, zoneId, {
      validation_default_mitigation_action: defaultAction,
      validation_override_mitigation_action: props.unknownOperationAction,
    });

    // Get current settings
    const settings = await getGlobalSettings(api, zoneId);

    // Parse the schema and extract operations if we have schema content
    let parsedOperations: Array<{
      method: string;
      endpoint: string;
      operationId?: string;
      host: string;
    }> = [];

    if (schemaContent) {
      parsedOperations = parseSchemaOperations(schemaContent);
    } else if (props.schema) {
      parsedOperations = parseSchemaOperations(props.schema);
    }

    // Create ApiGatewayOperation resources for each operation found in the schema
    const createdOperations: OperationValidation[] = [];

    // Only create operations if we have new schema content (not on updates with schema ID)
    if (parsedOperations.length > 0) {
      for (const parsedOp of parsedOperations) {
        // Create a deterministic ID for the operation
        const operationResourceId = `${_id}-${parsedOp.method.toLowerCase()}-${parsedOp.endpoint.replace(/[^a-z0-9]/gi, "-")}`;

        const apiOperation = await ApiGatewayOperation(operationResourceId, {
          zone: zoneId,
          endpoint: parsedOp.endpoint,
          host: parsedOp.host,
          method: parsedOp.method,
        });

        // Determine the action for this operation
        let operationAction = defaultAction;
        if (props.actions) {
          const pathActions = props.actions[parsedOp.endpoint];
          if (typeof pathActions === "string") {
            // Blanket action for all methods on this path
            operationAction = pathActions;
          } else if (pathActions && typeof pathActions === "object") {
            // Per-method configuration
            const methodAction =
              pathActions[parsedOp.method.toLowerCase() as HTTPMethod];
            if (methodAction) {
              operationAction = methodAction;
            }
          }
        }

        // Apply validation settings to the operation if needed
        if (operationAction !== defaultAction) {
          await updateOperationSettings(api, zoneId, apiOperation.operationId, {
            mitigation_action: operationAction,
          });
        }

        createdOperations.push({
          operationId: apiOperation.operationId,
          method: apiOperation.method,
          host: apiOperation.host,
          endpoint: apiOperation.endpoint,
          action: operationAction,
        });
      }
    } else if (this.output?.operations) {
      // If no new operations to create, return existing operations from previous state
      // and apply any new action configurations
      const existingOps = this.output.operations;

      for (const existingOp of existingOps) {
        let operationAction = existingOp.action;

        // Apply new actions if provided
        if (props.actions) {
          const pathActions = props.actions[existingOp.endpoint];
          if (typeof pathActions === "string") {
            operationAction = pathActions;
          } else if (pathActions && typeof pathActions === "object") {
            const methodAction =
              pathActions[existingOp.method.toLowerCase() as HTTPMethod];
            if (methodAction) {
              operationAction = methodAction;
            }
          }
        }

        // Update operation settings if action changed
        if (operationAction !== existingOp.action) {
          await updateOperationSettings(api, zoneId, existingOp.operationId, {
            mitigation_action: operationAction,
          });
        }

        createdOperations.push({
          operationId: existingOp.operationId,
          method: existingOp.method,
          host: existingOp.host,
          endpoint: existingOp.endpoint,
          action: operationAction,
        });
      }
    }

    // Return the operations (either newly created or updated existing ones)
    const operations = createdOperations;

    return this({
      zoneId,
      zoneName,
      schema: schemaDetails,
      settings: {
        defaultMitigationAction: settings.validation_default_mitigation_action,
        overrideMitigationAction:
          settings.validation_override_mitigation_action,
      },
      operations,
    });
  },
);

// Helper functions to parse OpenAPI schemas and extract operations

/**
 * Extract operations from an OpenAPI schema
 */
function parseSchemaOperations(
  schemaContent: string | OpenAPIV3.Document,
): Array<{
  method: string;
  endpoint: string;
  operationId?: string;
  host: string;
}> {
  const operations: Array<{
    method: string;
    endpoint: string;
    operationId?: string;
    host: string;
  }> = [];

  try {
    // Parse the schema content
    const schema: OpenAPIV3.Document =
      typeof schemaContent === "string"
        ? yaml.parse(schemaContent)
        : schemaContent;

    if (!schema?.paths) {
      return operations;
    }

    // Determine the host from servers
    const defaultHost = extractHostFromSchema(schema);

    // Extract operations from each path
    for (const [path, pathItem] of Object.entries(schema.paths)) {
      if (!pathItem || typeof pathItem !== "object") continue;

      // Check each HTTP method
      for (const method of [
        "get",
        "post",
        "put",
        "patch",
        "delete",
        "head",
        "options",
        "trace",
      ]) {
        const operation = pathItem[method as keyof typeof pathItem];
        if (
          operation &&
          typeof operation === "object" &&
          !Array.isArray(operation)
        ) {
          // Determine host for this operation (operation-level servers override global)
          const operationHost = (operation as any).servers?.[0]?.url
            ? extractHostFromUrl((operation as any).servers[0].url)
            : defaultHost;

          operations.push({
            method: method.toUpperCase(),
            endpoint: path,
            operationId: (operation as any).operationId,
            host: operationHost,
          });
        }
      }
    }
  } catch (error) {
    console.warn("Failed to parse schema for operations:", error);
  }

  return operations;
}

/**
 * Extract host from OpenAPI schema servers
 */
function extractHostFromSchema(schema: OpenAPIV3.Document): string {
  if (schema.servers && schema.servers.length > 0) {
    return extractHostFromUrl(schema.servers[0].url);
  }

  // Fallback to a default host
  return "api.example.com";
}

/**
 * Extract hostname from a URL
 */
function extractHostFromUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname;
  } catch {
    // If URL parsing fails, return the URL as-is (might be relative)
    return url;
  }
}

// Helper functions for API calls

async function uploadSchema(
  api: CloudflareApi,
  zoneId: string,
  params: {
    file: string;
    name: string;
    kind: SchemaKind;
    validation_enabled?: boolean;
  },
): Promise<SchemaDetails> {
  const formData = new FormData();
  formData.append("file", new Blob([params.file]), params.name);
  formData.append("name", params.name);
  formData.append("kind", params.kind);
  if (params.validation_enabled !== undefined) {
    formData.append("validation_enabled", String(params.validation_enabled));
  }

  const response = await api.post(
    `/zones/${zoneId}/api_gateway/user_schemas`,
    formData,
  );

  if (!response.ok) {
    await handleApiError(response, "uploading", "schema", params.name);
  }

  const data = (await response.json()) as {
    result: { schema: CloudflareSchema };
  };
  return {
    id: data.result.schema.schema_id,
    name: data.result.schema.name,
    kind: data.result.schema.kind as SchemaKind,
    source: data.result.schema.source,
    validationEnabled: data.result.schema.validation_enabled,
    createdAt: data.result.schema.created_at,
  };
}

async function getSchema(
  api: CloudflareApi,
  zoneId: string,
  schemaId: string,
): Promise<SchemaDetails | null> {
  const response = await api.get(
    `/zones/${zoneId}/api_gateway/user_schemas/${schemaId}`,
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

async function updateSchema(
  api: CloudflareApi,
  zoneId: string,
  schemaId: string,
  params: {
    validation_enabled: boolean;
  },
): Promise<SchemaDetails> {
  const response = await api.patch(
    `/zones/${zoneId}/api_gateway/user_schemas/${schemaId}`,
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
  const response = await api.delete(
    `/zones/${zoneId}/api_gateway/user_schemas/${schemaId}`,
  );

  if (!response.ok && response.status !== 404) {
    await handleApiError(response, "deleting", "schema", schemaId);
  }
}

async function getGlobalSettings(
  api: CloudflareApi,
  zoneId: string,
): Promise<CloudflareGlobalSettings> {
  const response = await api.get(
    `/zones/${zoneId}/api_gateway/settings/schema_validation`,
  );

  if (!response.ok) {
    await handleApiError(response, "getting", "global settings");
  }

  const data = (await response.json()) as { result: CloudflareGlobalSettings };
  return data.result;
}

async function updateGlobalSettings(
  api: CloudflareApi,
  zoneId: string,
  params: Partial<CloudflareGlobalSettings>,
): Promise<void> {
  const response = await api.put(
    `/zones/${zoneId}/api_gateway/settings/schema_validation`,
    params,
  );

  if (!response.ok) {
    await handleApiError(response, "updating", "global settings");
  }
}

async function getOperations(
  api: CloudflareApi,
  zoneId: string,
): Promise<CloudflareOperation[]> {
  const response = await api.get(`/zones/${zoneId}/api_gateway/operations`);

  if (!response.ok) {
    await handleApiError(response, "getting", "operations");
  }

  const data = (await response.json()) as { result: CloudflareOperation[] };
  return data.result;
}

async function updateOperationSettings(
  api: CloudflareApi,
  zoneId: string,
  operationId: string,
  params: {
    mitigation_action: ValidationAction;
  },
): Promise<void> {
  const response = await api.put(
    `/zones/${zoneId}/api_gateway/operations/${operationId}/schema_validation`,
    params,
  );

  if (!response.ok) {
    await handleApiError(
      response,
      "updating",
      "operation settings",
      operationId,
    );
  }
}

// Exported API functions for testing

/**
 * Get operations for a zone
 */
export async function getOperationsForZone(
  api: CloudflareApi,
  zoneId: string,
): Promise<CloudflareOperation[]> {
  return getOperations(api, zoneId);
}

/**
 * Get global schema validation settings for a zone
 */
export async function getGlobalSettingsForZone(
  api: CloudflareApi,
  zoneId: string,
): Promise<CloudflareGlobalSettings> {
  return getGlobalSettings(api, zoneId);
}

// Cloudflare API response types

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

export interface CloudflareGlobalSettings {
  validation_default_mitigation_action: ValidationAction;
  validation_override_mitigation_action?: ValidationAction;
}

export interface CloudflareOperation {
  operation_id: string;
  method: string;
  host: string;
  endpoint: string;
  mitigation_action: ValidationAction;
}
