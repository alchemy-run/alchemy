import type { Context } from "../context.ts";
import { Resource } from "../resource.ts";
import { handleApiError } from "./api-error.ts";
import { createCloudflareApi, type CloudflareApiOptions } from "./api.ts";
import type { Zone } from "./zone.ts";

/**
 * Properties for creating or updating an API Operation
 */
export interface ApiGatewayOperationProps extends CloudflareApiOptions {
  /**
   * The zone this operation belongs to
   */
  zone: string | Zone;

  /**
   * The API endpoint path (can contain path variables like /users/{id})
   */
  endpoint: string;

  /**
   * The host for this operation
   */
  host: string;

  /**
   * The HTTP method (GET, POST, PUT, DELETE, etc.)
   */
  method: string;
}

/**
 * API Operation output
 */
export interface ApiGatewayOperation
  extends Resource<"cloudflare::ApiGatewayOperation"> {
  /**
   * Zone ID
   */
  zoneId: string;

  /**
   * Zone name
   */
  zoneName: string;

  /**
   * Operation ID assigned by Cloudflare
   */
  operationId: string;

  /**
   * The API endpoint path
   */
  endpoint: string;

  /**
   * The host for this operation
   */
  host: string;

  /**
   * The HTTP method
   */
  method: string;

  /**
   * When this operation was last updated
   */
  lastUpdated: string;
}

/**
 * Cloudflare API Gateway Operation manages individual API endpoints that can be
 * monitored, secured, and configured through Cloudflare's API Shield.
 *
 * Operations are the building blocks for API management, representing specific
 * HTTP method + endpoint + host combinations that your API exposes.
 *
 * @example
 * ## Basic API operation
 *
 * Create a simple GET endpoint for user retrieval
 *
 * const getUserOp = await ApiGatewayOperation("get-users", {
 *   zone: myZone,
 *   endpoint: "/users",
 *   host: "api.example.com",
 *   method: "GET"
 * });
 *
 * @example
 * ## API operation with path parameters
 *
 * Create an operation that includes path variables
 *
 * const getUserByIdOp = await ApiGatewayOperation("get-user-by-id", {
 *   zone: "api.example.com",
 *   endpoint: "/users/{id}",
 *   host: "api.example.com",
 *   method: "GET"
 * });
 *
 * @example
 * ## RESTful CRUD operations
 *
 * Create a complete set of CRUD operations for a resource
 *
 * const createUserOp = await ApiGatewayOperation("create-user", {
 *   zone: myZone,
 *   endpoint: "/users",
 *   host: "api.example.com",
 *   method: "POST"
 * });
 *
 * const updateUserOp = await ApiGatewayOperation("update-user", {
 *   zone: myZone,
 *   endpoint: "/users/{id}",
 *   host: "api.example.com",
 *   method: "PUT"
 * });
 *
 * const deleteUserOp = await ApiGatewayOperation("delete-user", {
 *   zone: myZone,
 *   endpoint: "/users/{id}",
 *   host: "api.example.com",
 *   method: "DELETE"
 * });
 *
 * @see https://developers.cloudflare.com/api/resources/api_gateway/subresources/operations/
 * @see https://developers.cloudflare.com/api-shield/management-and-monitoring/endpoint-management/
 */
export const ApiGatewayOperation = Resource(
  "cloudflare::ApiGatewayOperation",
  async function (
    this: Context<ApiGatewayOperation>,
    _id: string,
    props: ApiGatewayOperationProps,
  ): Promise<ApiGatewayOperation> {
    const api = await createCloudflareApi(props);
    console.log(this.phase, _id);

    // Resolve zone ID and name
    const zoneId = typeof props.zone === "string" ? props.zone : props.zone.id;
    const zoneName =
      typeof props.zone === "string" ? props.zone : props.zone.name;

    if (this.phase === "delete") {
      if (this.output?.operationId) {
        try {
          const deleteResponse = await api.delete(
            `/zones/${zoneId}/api_gateway/operations/${this.output.operationId}`,
          );

          if (!deleteResponse.ok && deleteResponse.status !== 404) {
            console.error(
              "Error deleting operation:",
              deleteResponse.statusText,
            );
          }
        } catch (error) {
          console.error("Error deleting operation:", error);
        }
      }

      return this.destroy();
    }

    try {
      // Create the operation
      const response = await api.post(
        `/zones/${zoneId}/api_gateway/operations/item`,
        {
          endpoint: props.endpoint,
          host: props.host,
          method: props.method.toUpperCase(),
        },
      );

      if (!response.ok) {
        await handleApiError(
          response,
          "creating",
          "operation",
          `${props.method} ${props.endpoint}`,
        );
      }

      const data = (await response.json()) as {
        result: {
          operation_id: string;
          endpoint: string;
          host: string;
          method: string;
          last_updated: string;
        };
      };

      return this({
        zoneId,
        zoneName,
        operationId: data.result.operation_id,
        endpoint: props.endpoint, // Use original endpoint from props, not normalized version
        host: props.host, // Use original host from props
        method: props.method.toUpperCase(), // Use original method from props
        lastUpdated: data.result.last_updated,
      });
    } catch (error) {
      console.error("Error creating/updating operation:", error);
      throw error;
    }
  },
);
