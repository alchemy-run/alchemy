import type { Context } from "../context.ts";
import { Resource } from "../resource.ts";
import { logger } from "../util/logger.ts";
import { CloudflareApiError, handleApiError } from "./api-error.ts";
import {
  extractCloudflareResult,
  type CloudflareApiErrorPayload,
} from "./api-response.ts";
import {
  createCloudflareApi,
  type CloudflareApi,
  type CloudflareApiOptions,
} from "./api.ts";

export type CheckRegion =
  | "WNAM"
  | "ENAM"
  | "WEU"
  | "EEU"
  | "NSAM"
  | "SSAM"
  | "OC"
  | "ME"
  | "NAF"
  | "SAF"
  | "IN"
  | "SEAS"
  | "NEAS"
  | "ALL_REGIONS";

export interface HTTPConfiguration {
  /**
   * Do not validate the certificate when the health check uses HTTPS
   * @default false
   */
  allowInsecure?: boolean;

  /**
   * A case-insensitive sub-string to look for in the response body
   * If this string is not found, the origin will be marked as unhealthy
   */
  expectedBody?: string;

  /**
   * The expected HTTP response codes (e.g. "200") or code ranges (e.g. "2xx" for all codes starting with 2)
   */
  expectedCodes?: string[] | null;

  /**
   * Follow redirects if the origin returns a 3xx status code
   * @default false
   */
  followRedirects?: boolean;

  /**
   * The HTTP request headers to send in the health check
   * It is recommended you set a Host header by default
   * The User-Agent header cannot be overridden
   */
  header?: Record<string, string[]> | null;

  /**
   * The HTTP method to use for the health check
   * @default "GET"
   */
  method?: "GET" | "HEAD";

  /**
   * The endpoint path to health check against
   * @default "/"
   */
  path?: string;

  /**
   * Port number to connect to for the health check
   * @default 80 for HTTP
   * @default 443 for HTTPS
   */
  port?: number;
}

export interface TCPConfiguration {
  /**
   * The TCP connection method to use for the health check
   * @default "connection_established"
   */
  method?: "connection_established";

  /**
   * Port number to connect to for the health check
   * @default 80
   */
  port?: number;
}

/**
 * Properties for creating or updating a Cloudflare Health Check
 */
export interface HealthCheckProps extends CloudflareApiOptions {
  /**
   * The Cloudflare Zone ID this health check belongs to
   */
  zoneId: string;

  /**
   * The hostname or IP address of the origin server to run health checks on
   */
  address: string;

  /**
   * A short name to identify the health check
   * Only alphanumeric characters, hyphens and underscores are allowed
   */
  name: string;

  /**
   * A list of regions from which to run health checks
   * Null means Cloudflare will pick a default region
   */
  checkRegions?: CheckRegion[] | null;

  /**
   * The number of consecutive fails required from a health check before changing the health to unhealthy
   * @default 1
   */
  consecutiveFails?: number;

  /**
   * The number of consecutive successes required from a health check before changing the health to healthy
   * @default 1
   */
  consecutiveSuccesses?: number;

  /**
   * A human-readable description of the health check
   */
  description?: string;

  /**
   * Parameters specific to an HTTP or HTTPS health check
   */
  httpConfig?: HTTPConfiguration | null;

  /**
   * The interval between each health check in seconds
   * Shorter intervals may give quicker notifications if the origin status changes,
   * but will increase load on the origin as we check from multiple locations
   * @default 60
   */
  interval?: number;

  /**
   * The number of retries to attempt in case of a timeout before marking the origin as unhealthy
   * Retries are attempted immediately
   * @default 2
   */
  retries?: number;

  /**
   * If suspended, no health checks are sent to the origin
   * @default false
   */
  suspended?: boolean;

  /**
   * Parameters specific to TCP health check
   */
  tcpConfig?: TCPConfiguration | null;

  /**
   * The timeout (in seconds) before marking the health check as failed
   * @default 5
   */
  timeout?: number;

  /**
   * The protocol to use for the health check
   * Currently supported protocols are 'HTTP', 'HTTPS' and 'TCP'
   * @default "HTTP"
   */
  type?: string;

  /**
   * Whether to adopt an existing health check
   * @default false
   */
  adopt?: boolean;

  /**
   * The Cloudflare-generated health check ID (used internally for updates)
   * @internal
   */
  healthCheckId?: string;
}

/**
 * Output returned after Cloudflare Health Check creation/update
 * IMPORTANT: The interface name MUST match the exported resource name
 */
export interface HealthCheck extends HealthCheckProps {
  /**
   * The resource ID
   */
  id: string;

  /**
   * The Cloudflare-generated health check ID
   */
  healthCheckId: string;

  /**
   * Time at which the health check was created
   */
  createdOn?: string;

  /**
   * Time at which the health check was last modified
   */
  modifiedOn?: string;

  /**
   * The current status of the origin server according to the health check
   */
  status?: "unknown" | "healthy" | "unhealthy" | "suspended";

  /**
   * The current failure reason if status is unhealthy
   */
  failureReason?: string;
}

/**
 * Represents a Cloudflare Health Check for monitoring origin server availability.
 *
 * Health Checks monitor the availability of your origin servers and can be used
 * with Load Balancers to automatically route traffic away from unhealthy origins.
 *
 * @example
 * // Create a basic HTTP health check
 * const basicHealthCheck = await HealthCheck("api-healthcheck", {
 *   zoneId: "023e105f4ecef8ad9ca31a8372d0c353",
 *   address: "api.example.com",
 *   name: "api-server-check"
 * });
 *
 * @example
 * // Create an HTTPS health check with custom path and expected response
 * const httpsHealthCheck = await HealthCheck("secure-api-check", {
 *   zoneId: "023e105f4ecef8ad9ca31a8372d0c353",
 *   address: "secure-api.example.com",
 *   name: "secure-api-check",
 *   type: "HTTPS",
 *   httpConfig: {
 *     path: "/health",
 *     expectedCodes: ["200", "201"],
 *     expectedBody: "OK",
 *     method: "GET"
 *   }
 * });
 *
 * @example
 * // Create a health check with custom intervals and retry logic
 * const customHealthCheck = await HealthCheck("custom-check", {
 *   zoneId: "023e105f4ecef8ad9ca31a8372d0c353",
 *   address: "backend.example.com",
 *   name: "backend-check",
 *   interval: 30,
 *   timeout: 10,
 *   retries: 3,
 *   consecutiveFails: 2,
 *   consecutiveSuccesses: 2,
 *   description: "Backend server health monitoring"
 * });
 *
 * @example
 * // Create a TCP health check
 * const tcpHealthCheck = await HealthCheck("tcp-check", {
 *   zoneId: "023e105f4ecef8ad9ca31a8372d0c353",
 *   address: "database.example.com",
 *   name: "database-check",
 *   type: "TCP",
 *   tcpConfig: {
 *     port: 5432,
 *     method: "connection_established"
 *   }
 * });
 *
 * @example
 * // Create a health check with specific regions and custom headers
 * const regionalHealthCheck = await HealthCheck("regional-check", {
 *   zoneId: "023e105f4ecef8ad9ca31a8372d0c353",
 *   address: "api.example.com",
 *   name: "regional-api-check",
 *   checkRegions: ["WNAM", "ENAM", "WEU"],
 *   httpConfig: {
 *     path: "/api/health",
 *     header: {
 *       "Host": ["api.example.com"],
 *       "X-Health-Check": ["true"]
 *     },
 *     followRedirects: true
 *   }
 * });
 */
export const HealthCheck = Resource(
  "cloudflare::HealthCheck",
  async function (
    this: Context<HealthCheck>,
    id: string,
    props: HealthCheckProps,
  ): Promise<HealthCheck> {
    const healthCheckId = props.healthCheckId || this.output?.healthCheckId;
    const adopt = props.adopt ?? this.scope.adopt;

    const api = await createCloudflareApi(props);

    if (this.phase === "delete") {
      if (!healthCheckId) {
        logger.warn(`No healthCheckId found for ${id}, skipping delete`);
        return this.destroy();
      }

      try {
        const deleteResponse = await api.delete(
          `/zones/${props.zoneId}/healthchecks/${healthCheckId}`,
        );

        if (!deleteResponse.ok && deleteResponse.status !== 404) {
          await handleApiError(deleteResponse, "delete", "health check", id);
        }
      } catch (error) {
        logger.error(`Error deleting Health Check ${id}:`, error);
        throw error;
      }
      return this.destroy();
    }

    const requestBody = prepareRequestBody(props);
    let result: HealthCheckResponse;

    if (healthCheckId) {
      result = await extractCloudflareResult<HealthCheckResponse>(
        `update health check "${healthCheckId}"`,
        api.patch(
          `/zones/${props.zoneId}/healthchecks/${healthCheckId}`,
          requestBody,
        ),
      );
    } else {
      try {
        result = await extractCloudflareResult<HealthCheckResponse>(
          `create health check "${props.name}"`,
          api.post(`/zones/${props.zoneId}/healthchecks`, requestBody),
        );
      } catch (error) {
        if (
          error instanceof CloudflareApiError &&
          (error.errorData as CloudflareApiErrorPayload[]).some(
            (e) => e.code === 1004 || e.message?.includes("already exists"),
          )
        ) {
          if (!adopt) {
            throw new Error(
              `Health check "${props.name}" already exists. Use adopt: true to adopt it.`,
              { cause: error },
            );
          }
          const existing = await findHealthCheckByName(
            api,
            props.zoneId,
            props.name,
          );
          if (!existing) {
            throw new Error(
              `Health check "${props.name}" failed to create due to name conflict and could not be found for adoption.`,
              { cause: error },
            );
          }
          result = await extractCloudflareResult<HealthCheckResponse>(
            `adopt health check "${props.name}"`,
            api.patch(
              `/zones/${props.zoneId}/healthchecks/${existing.id}`,
              requestBody,
            ),
          );
        } else {
          throw error;
        }
      }
    }

    return {
      id,
      healthCheckId: result.id!,
      zoneId: props.zoneId,
      address: result.address!,
      name: result.name!,
      checkRegions: result.check_regions,
      consecutiveFails: result.consecutive_fails,
      consecutiveSuccesses: result.consecutive_successes,
      description: result.description,
      httpConfig: result.http_config
        ? mapHttpConfigFromApi(result.http_config)
        : undefined,
      interval: result.interval,
      retries: result.retries,
      suspended: result.suspended,
      tcpConfig: result.tcp_config
        ? mapTcpConfigFromApi(result.tcp_config)
        : undefined,
      timeout: result.timeout,
      type: result.type,
      createdOn: result.created_on,
      modifiedOn: result.modified_on,
      status: result.status,
      failureReason: result.failure_reason,
      accountId: props.accountId,
      apiToken: props.apiToken,
    };
  },
);

/**
 * API response format (snake_case from Cloudflare API)
 * @internal
 */
interface HealthCheckResponse {
  id?: string;
  address?: string;
  name?: string;
  check_regions?: CheckRegion[] | null;
  consecutive_fails?: number;
  consecutive_successes?: number;
  created_on?: string;
  description?: string;
  failure_reason?: string;
  http_config?: {
    allow_insecure?: boolean;
    expected_body?: string;
    expected_codes?: string[] | null;
    follow_redirects?: boolean;
    header?: Record<string, string[]> | null;
    method?: "GET" | "HEAD";
    path?: string;
    port?: number;
  } | null;
  interval?: number;
  modified_on?: string;
  retries?: number;
  status?: "unknown" | "healthy" | "unhealthy" | "suspended";
  suspended?: boolean;
  tcp_config?: {
    method?: "connection_established";
    port?: number;
  } | null;
  timeout?: number;
  type?: string;
}

/**
 * Find a health check by name
 * @internal
 */
async function findHealthCheckByName(
  api: CloudflareApi,
  zoneId: string,
  name: string,
  page = 1,
): Promise<HealthCheckResponse | null> {
  const response = await api.get(
    `/zones/${zoneId}/healthchecks?page=${page}&per_page=50`,
  );
  const data: {
    result: HealthCheckResponse[];
    result_info?: { total_pages?: number };
  } = await response.json();
  const found = data.result.find((check) => check.name === name);
  if (found) {
    return found;
  }
  if (data.result_info?.total_pages && page < data.result_info.total_pages) {
    return await findHealthCheckByName(api, zoneId, name, page + 1);
  }
  return null;
}

/**
 * Prepare the request body by converting to snake_case
 * @internal
 */
function prepareRequestBody(props: HealthCheckProps): any {
  const body: any = {
    address: props.address,
    name: props.name,
  };

  if (props.checkRegions !== undefined) {
    body.check_regions = props.checkRegions;
  }
  if (props.consecutiveFails !== undefined) {
    body.consecutive_fails = props.consecutiveFails;
  }
  if (props.consecutiveSuccesses !== undefined) {
    body.consecutive_successes = props.consecutiveSuccesses;
  }
  if (props.description !== undefined) {
    body.description = props.description;
  }
  if (props.httpConfig !== undefined) {
    body.http_config = props.httpConfig
      ? {
          allow_insecure: props.httpConfig.allowInsecure,
          expected_body: props.httpConfig.expectedBody,
          expected_codes: props.httpConfig.expectedCodes,
          follow_redirects: props.httpConfig.followRedirects,
          header: props.httpConfig.header,
          method: props.httpConfig.method,
          path: props.httpConfig.path,
          port: props.httpConfig.port,
        }
      : null;
  }
  if (props.interval !== undefined) {
    body.interval = props.interval;
  }
  if (props.retries !== undefined) {
    body.retries = props.retries;
  }
  if (props.suspended !== undefined) {
    body.suspended = props.suspended;
  }
  if (props.tcpConfig !== undefined) {
    body.tcp_config = props.tcpConfig
      ? {
          method: props.tcpConfig.method,
          port: props.tcpConfig.port,
        }
      : null;
  }
  if (props.timeout !== undefined) {
    body.timeout = props.timeout;
  }
  if (props.type !== undefined) {
    body.type = props.type;
  }

  return body;
}

/**
 * Map HTTP config from API response (snake_case) to camelCase
 * @internal
 */
function mapHttpConfigFromApi(
  apiConfig: NonNullable<HealthCheckResponse["http_config"]>,
): HTTPConfiguration {
  return {
    allowInsecure: apiConfig.allow_insecure,
    expectedBody: apiConfig.expected_body,
    expectedCodes: apiConfig.expected_codes,
    followRedirects: apiConfig.follow_redirects,
    header: apiConfig.header,
    method: apiConfig.method,
    path: apiConfig.path,
    port: apiConfig.port,
  };
}

/**
 * Map TCP config from API response (snake_case) to camelCase
 * @internal
 */
function mapTcpConfigFromApi(
  apiConfig: NonNullable<HealthCheckResponse["tcp_config"]>,
): TCPConfiguration {
  return {
    method: apiConfig.method,
    port: apiConfig.port,
  };
}
