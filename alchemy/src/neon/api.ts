import type { Secret } from "../secret.ts";
import { withExponentialBackoff } from "../util/retry.ts";
import { safeFetch } from "../util/safe-fetch.ts";

/**
 * Options for Neon API requests
 */
export interface NeonApiOptions {
  /**
   * Base URL for Neon API
   * @default https://console.neon.tech/api/v2
   */
  baseUrl?: string;

  /**
   * API Key to use (overrides NEON_API_KEY env var)
   */
  apiKey?: Secret;
}

/**
 * Create a NeonApi instance with environment variable fallback
 * @param options API options
 * @returns NeonApi instance
 */
export function createNeonApi(options: Partial<NeonApiOptions> = {}): NeonApi {
  return new NeonApi({
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
  });
}

/**
 * Get authentication headers for Neon API
 * @param options NeonApiOptions
 * @returns Headers for authentication
 */
export async function getNeonAuthHeaders(
  options: Partial<NeonApiOptions>,
): Promise<Record<string, string>> {
  const apiKey = options.apiKey?.unencrypted ?? process.env.NEON_API_KEY;

  if (!apiKey) {
    throw new Error(
      "Neon API key is required. Set NEON_API_KEY environment variable or provide apiKey option.",
    );
  }

  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
}

/**
 * Neon API client using raw fetch
 */
export class NeonApi {
  public readonly baseUrl: string;

  /**
   * Create a new Neon API client
   * Use createNeonApi factory function instead of direct constructor
   *
   * @param options API options
   */
  constructor(private readonly options: NeonApiOptions) {
    this.baseUrl = options.baseUrl ?? "https://console.neon.tech/api/v2";
  }

  /**
   * Make a fetch request to the Neon API
   *
   * @param path API path (without base URL)
   * @param init Fetch init options
   * @returns Raw Response object from fetch
   */
  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    let headers: Record<string, string> = {};

    if (Array.isArray(init.headers)) {
      init.headers.forEach(([key, value]) => {
        headers[key] = value;
      });
    } else if (init.headers instanceof Headers) {
      init.headers.forEach((value, key) => {
        headers[key] = value;
      });
    } else if (init.headers) {
      headers = init.headers as Record<string, string>;
    }

    headers = {
      ...(await getNeonAuthHeaders(this.options)),
      ...headers,
    };

    // Use withExponentialBackoff for automatic retry on network errors
    return withExponentialBackoff(
      () =>
        safeFetch(`${this.baseUrl}${path}`, {
          ...init,
          headers,
        }),
      (error) => {
        // Only retry on network-related errors
        const errorMsg = (error as Error).message || "";
        const isNetworkError =
          errorMsg.includes("socket connection was closed") ||
          errorMsg.includes("ECONNRESET") ||
          errorMsg.includes("ETIMEDOUT") ||
          errorMsg.includes("ECONNREFUSED");

        return isNetworkError || error?.status?.toString().startsWith("5");
      },
      5, // Maximum 5 attempts (1 initial + 4 retries)
      1000, // Start with 1s delay, will exponentially increase
    );
  }

  /**
   * Helper for GET requests
   */
  async get(path: string, init: RequestInit = {}): Promise<Response> {
    return this.fetch(path, { ...init, method: "GET" });
  }

  /**
   * Helper for POST requests
   */
  async post(
    path: string,
    body: any,
    init: RequestInit = {},
  ): Promise<Response> {
    const requestBody =
      body instanceof FormData
        ? body
        : typeof body === "string"
          ? body
          : JSON.stringify(body);
    return this.fetch(path, { ...init, method: "POST", body: requestBody });
  }

  /**
   * Helper for PUT requests
   */
  async put(
    path: string,
    body: any,
    init: RequestInit = {},
  ): Promise<Response> {
    const requestBody = body instanceof FormData ? body : JSON.stringify(body);
    return this.fetch(path, { ...init, method: "PUT", body: requestBody });
  }

  /**
   * Helper for PATCH requests
   */
  async patch(
    path: string,
    body: any,
    init: RequestInit = {},
  ): Promise<Response> {
    return this.fetch(path, {
      ...init,
      method: "PATCH",
      body: JSON.stringify(body),
    });
  }

  /**
   * Helper for DELETE requests
   */
  async delete(path: string, init: RequestInit = {}): Promise<Response> {
    return this.fetch(path, { ...init, method: "DELETE" });
  }
}

export declare namespace Neon {
  export interface Branch {
    /**
     * The branch ID. This value is generated when a branch is created. A `branch_id` value has a `br` prefix. For example: `br-small-term-683261`.
     *
     */
    id: string;
    /**
     * The ID of the project to which the branch belongs
     *
     */
    project_id: string;
    /**
     * The `branch_id` of the parent branch
     *
     */
    parent_id?: string;
    /**
     * The Log Sequence Number (LSN) on the parent branch from which this branch was created.
     * When restoring a branch using the [Restore branch](https://api-docs.neon.tech/reference/restoreprojectbranch) endpoint,
     * this value isn’t finalized until all operations related to the restore have completed successfully.
     *
     */
    parent_lsn?: string;
    /**
     * The point in time on the parent branch from which this branch was created.
     * When restoring a branch using the [Restore branch](https://api-docs.neon.tech/reference/restoreprojectbranch) endpoint,
     * this value isn’t finalized until all operations related to the restore have completed successfully.
     * After all the operations completed, this value might stay empty.
     *
     */
    parent_timestamp?: string;
    /**
     * The branch name
     *
     */
    name: string;
    current_state: string;
    pending_state?: string;
    /**
     * A UTC timestamp indicating when the `current_state` began
     *
     */
    state_changed_at: string;
    /**
     * The logical size of the branch, in bytes
     *
     */
    logical_size?: number;
    /**
     * The branch creation source
     *
     */
    creation_source: string;
    /**
     * DEPRECATED. Use `default` field.
     * Whether the branch is the project's primary branch
     *
     * @deprecated
     */
    primary?: boolean;
    /**
     * Whether the branch is the project's default branch
     *
     */
    default: boolean;
    /**
     * Whether the branch is protected
     *
     */
    protected: boolean;
    /**
     * CPU seconds used by all of the branch's compute endpoints, including deleted ones.
     * This value is reset at the beginning of each billing period.
     * Examples:
     * 1. A branch that uses 1 CPU for 1 second is equal to `cpu_used_sec=1`.
     * 2. A branch that uses 2 CPUs simultaneously for 1 second is equal to `cpu_used_sec=2`.
     *
     * @deprecated
     */
    cpu_used_sec: number;
    compute_time_seconds: number;
    active_time_seconds: number;
    written_data_bytes: number;
    data_transfer_bytes: number;
    /**
     * A timestamp indicating when the branch was created
     *
     */
    created_at: string;
    /**
     * A timestamp indicating when the branch was last updated
     *
     */
    updated_at: string;
    /**
     * The time-to-live (TTL) duration originally configured for the branch, in seconds. This read-only value represents the interval between the time `expires_at` was set and the expiration timestamp itself. It is preserved to ensure the same TTL duration is reapplied when resetting the branch from its parent, and only updates when a new `expires_at` value is set.
     *
     * Access to this feature is currently limited to participants in the Early Access Program.
     *
     */
    ttl_interval_seconds?: number;
    /**
     * The timestamp when the branch is scheduled to expire and be automatically deleted. Must be set by the client following the [RFC 3339, section 5.6](https://tools.ietf.org/html/rfc3339#section-5.6) format with precision up to seconds (such as 2025-06-09T18:02:16Z). Deletion is performed by a background job and may not occur exactly at the specified time.
     *
     * Access to this feature is currently limited to participants in the Early Access Program.
     *
     */
    expires_at?: string;
    /**
     * A timestamp indicating when the branch was last reset
     *
     */
    last_reset_at?: string;
    /**
     * The resolved user model that contains details of the user/org/integration/api_key used for branch creation. This field is filled only in listing/get/create/get/update/delete methods, if it is empty when calling other handlers, it does not mean that it is empty in the system.
     *
     */
    created_by?: {
      /**
       * The name of the user.
       */
      name?: string;
      /**
       * The URL to the user's avatar image.
       */
      image?: string;
    };
    /**
     * The source of initialization for the branch. Valid values are `schema-only` and `parent-data` (default).
     * * `schema-only` - creates a new root branch containing only the schema. Use `parent_id` to specify the source branch. Optionally, you can provide `parent_lsn` or `parent_timestamp` to branch from a specific point in time or LSN. These fields define which branch to copy the schema from and at what point—they do not establish a parent-child relationship between the `parent_id` branch and the new schema-only branch.
     * * `parent-data` - creates the branch with both schema and data from the parent.
     *
     */
    init_source?: string;
    restore_status?: string;
    /**
     * ID of the snapshot that was the restore source for this branch
     *
     */
    restored_from?: string;
  }

  export interface Database {
    /**
     * The database ID
     */
    id: number;
    /**
     * The ID of the branch to which the database belongs
     */
    branch_id: string;
    /**
     * The database name
     */
    name: string;
    /**
     * The name of role that owns the database
     */
    owner_name: string;
    /**
     * A timestamp indicating when the database was created
     */
    created_at: string;
    /**
     * A timestamp indicating when the database was last updated
     */
    updated_at: string;
  }

  export interface Endpoint {
    /**
     * The hostname of the compute endpoint. This is the hostname specified when connecting to a Neon database.
     *
     */
    host: string;
    /**
     * The compute endpoint ID. Compute endpoint IDs have an `ep-` prefix. For example: `ep-little-smoke-851426`
     *
     */
    id: string;
    /**
     * Optional name of the compute endpoint
     *
     */
    name?: string;
    /**
     * The ID of the project to which the compute endpoint belongs
     *
     */
    project_id: string;
    /**
     * The ID of the branch that the compute endpoint is associated with
     *
     */
    branch_id: string;
    autoscaling_limit_min_cu: number;
    autoscaling_limit_max_cu: number;
    /**
     * The region identifier
     *
     */
    region_id: string;
    type: Endpoint.Type;
    current_state: Endpoint.State;
    pending_state?: Endpoint.State;
    settings: Endpoint.Settings;
    /**
     * Whether connection pooling is enabled for the compute endpoint
     *
     */
    pooler_enabled: boolean;
    pooler_mode: Endpoint.PoolerMode;
    /**
     * Whether to restrict connections to the compute endpoint.
     * Enabling this option schedules a suspend compute operation.
     * A disabled compute endpoint cannot be enabled by a connection or
     * console action.
     *
     */
    disabled: boolean;
    /**
     * Whether to permit passwordless access to the compute endpoint
     *
     */
    passwordless_access: boolean;
    /**
     * A timestamp indicating when the compute endpoint was last active
     *
     */
    last_active?: string;
    /**
     * The compute endpoint creation source
     *
     */
    creation_source: string;
    /**
     * A timestamp indicating when the compute endpoint was created
     *
     */
    created_at: string;
    /**
     * A timestamp indicating when the compute endpoint was last updated
     *
     */
    updated_at: string;
    /**
     * A timestamp indicating when the compute endpoint was last started
     *
     */
    started_at?: string;
    /**
     * A timestamp indicating when the compute endpoint was last suspended
     *
     */
    suspended_at?: string;
    /**
     * DEPRECATED. Use the "host" property instead.
     *
     */
    proxy_host: string;
    suspend_timeout_seconds: number;
    provisioner: string;
    /**
     * Attached compute's release version number.
     *
     */
    compute_release_version?: string;
  }

  export interface Project {
    /**
     * Bytes-Hour. Project consumed that much storage hourly during the billing period. The value has some lag.
     * The value is reset at the beginning of each billing period.
     *
     */
    data_storage_bytes_hour: number;
    /**
     * Bytes. Egress traffic from the Neon cloud to the client for given project over the billing period.
     * Includes deleted endpoints. The value has some lag. The value is reset at the beginning of each billing period.
     *
     */
    data_transfer_bytes: number;
    /**
     * Bytes. Amount of WAL that travelled through storage for given project across all branches.
     * The value has some lag. The value is reset at the beginning of each billing period.
     *
     */
    written_data_bytes: number;
    /**
     * Seconds. The number of CPU seconds used by the project's compute endpoints, including compute endpoints that have been deleted.
     * The value has some lag. The value is reset at the beginning of each billing period.
     * Examples:
     * 1. An endpoint that uses 1 CPU for 1 second is equal to `compute_time=1`.
     * 2. An endpoint that uses 2 CPUs simultaneously for 1 second is equal to `compute_time=2`.
     *
     */
    compute_time_seconds: number;
    /**
     * Seconds. Control plane observed endpoints of this project being active this amount of wall-clock time.
     * The value has some lag.
     * The value is reset at the beginning of each billing period.
     *
     */
    active_time_seconds: number;
    /**
     * DEPRECATED, use compute_time instead.
     *
     * @deprecated
     */
    cpu_used_sec: number;
    /**
     * The project ID
     */
    id: string;
    /**
     * The cloud platform identifier. Currently, only AWS is supported, for which the identifier is `aws`.
     *
     */
    platform_id: string;
    /**
     * The region identifier
     *
     */
    region_id: string;
    /**
     * The project name
     *
     */
    name: string;
    provisioner: string;
    default_endpoint_settings?: {
      pg_settings?: Record<string, string>;
      pgbouncer_settings?: Record<string, string>;
      autoscaling_limit_min_cu?: number;
      autoscaling_limit_max_cu?: number;
      suspend_timeout_seconds?: number;
    };
    settings?: {
      /**
       * Per-project consumption quotas. If a quota is exceeded, all active computes
       * are automatically suspended and cannot be started via API calls or incoming connections.
       *
       * The exception is `logical_size_bytes`, which is enforced per branch.
       * If a branch exceeds its `logical_size_bytes` quota, computes can still be started,
       * but write operations will fail—allowing data to be deleted to free up space.
       * Computes on other branches are not affected.
       *
       * Setting `logical_size_bytes` overrides any lower value set by the `neon.max_cluster_size` Postgres setting.
       *
       * Quotas are enforced using per-project consumption metrics with the same names.
       * These metrics reset at the start of each billing period. `logical_size_bytes`
       * is also an exception—it reflects the total data stored in a branch and does not reset.
       *
       * A zero or empty quota value means “unlimited.”
       *
       */
      quota?: {
        /**
         * The total amount of wall-clock time allowed to be spent by the project's compute endpoints.
         *
         */
        active_time_seconds?: number;
        /**
         * The total amount of CPU seconds allowed to be spent by the project's compute endpoints.
         *
         */
        compute_time_seconds?: number;
        /**
         * Total amount of data written to all of a project's branches.
         *
         */
        written_data_bytes?: number;
        /**
         * Total amount of data transferred from all of a project's branches using the proxy.
         *
         */
        data_transfer_bytes?: number;
        /**
         * Limit on the logical size of every project's branch.
         *
         * If a branch exceeds its `logical_size_bytes` quota, computes can still be started,
         * but write operations will fail—allowing data to be deleted to free up space.
         * Computes on other branches are not affected.
         *
         * Setting `logical_size_bytes` overrides any lower value set by the `neon.max_cluster_size` Postgres setting.
         *
         */
        logical_size_bytes?: number;
      };
      /**
       * A list of IP addresses that are allowed to connect to the compute endpoint.
       * If the list is empty or not set, all IP addresses are allowed.
       * If protected_branches_only is true, the list will be applied only to protected branches.
       *
       */
      allowed_ips?: {
        /**
         * A list of IP addresses that are allowed to connect to the endpoint.
         */
        ips?: Array<string>;
        /**
         * If true, the list will be applied only to protected branches.
         */
        protected_branches_only?: boolean;
      };
      /**
       * Sets wal_level=logical for all compute endpoints in this project.
       * All active endpoints will be suspended.
       * Once enabled, logical replication cannot be disabled.
       *
       */
      enable_logical_replication?: boolean;
      /**
       * A maintenance window is a time period during which Neon may perform maintenance on the project's infrastructure.
       * During this time, the project's compute endpoints may be unavailable and existing connections can be
       * interrupted.
       */
      maintenance_window?: {
        /**
         * A list of weekdays when the maintenance window is active.
         * Encoded as ints, where 1 - Monday, and 7 - Sunday.
         *
         */
        weekdays: Array<number>;
        /**
         * Start time of the maintenance window, in the format of "HH:MM". Uses UTC.
         *
         */
        start_time: string;
        /**
         * End time of the maintenance window, in the format of "HH:MM". Uses UTC.
         *
         */
        end_time: string;
      };
      /**
       * When set, connections from the public internet
       * are disallowed. This supersedes the AllowedIPs list.
       * This parameter is under active development and its semantics may change in the future.
       *
       */
      block_public_connections?: boolean;
      /**
       * When set, connections using VPC endpoints are disallowed.
       * This parameter is under active development and its semantics may change in the future.
       *
       */
      block_vpc_connections?: boolean;
      audit_log_level?: "base" | "extended" | "full";
      hipaa?: boolean;
      preload_libraries?: {
        use_defaults?: boolean;
        enabled_libraries?: string[];
      };
    };
    pg_version: 15 | 16 | 17 | 18;
    /**
     * The proxy host for the project. This value combines the `region_id`, the `platform_id`, and the Neon domain (`neon.tech`).
     *
     */
    proxy_host: string;
    /**
     * The logical size limit for a branch. The value is in MiB.
     *
     */
    branch_logical_size_limit: number;
    /**
     * The logical size limit for a branch. The value is in B.
     *
     */
    branch_logical_size_limit_bytes: number;
    /**
     * Whether or not passwords are stored for roles in the Neon project. Storing passwords facilitates access to Neon features that require authorization.
     *
     */
    store_passwords: boolean;
    /**
     * A timestamp indicating when project maintenance begins. If set, the project is placed into maintenance mode at this time.
     *
     */
    maintenance_starts_at?: string;
    /**
     * The project creation source
     *
     */
    creation_source: string;
    /**
     * The number of seconds to retain the shared history for all branches in this project.
     *
     */
    history_retention_seconds: number;
    /**
     * A timestamp indicating when the project was created
     *
     */
    created_at: string;
    /**
     * A timestamp indicating when the project was last updated
     *
     */
    updated_at: string;
    /**
     * The current space occupied by the project in storage, in bytes. Synthetic storage size combines the logical data size and Write-Ahead Log (WAL) size for all branches in a project.
     *
     */
    synthetic_storage_size?: number;
    /**
     * A date-time indicating when Neon Cloud started measuring consumption for current consumption period.
     *
     */
    consumption_period_start: string;
    /**
     * A date-time indicating when Neon Cloud plans to stop measuring consumption for current consumption period.
     *
     */
    consumption_period_end: string;
    /**
     * DEPRECATED. Use `consumption_period_end` from the getProject endpoint instead.
     * A timestamp indicating when the project quota resets.
     *
     * @deprecated
     */
    quota_reset_at?: string;
    owner_id: string;
    owner?: {
      email: string;
      name: string;
      branches_limit: number;
      subscription_type:
        | "UNKNOWN"
        | "direct_sales"
        | "aws_marketplace"
        | "free_v2"
        | "free_v3"
        | "launch"
        | "launch_v3"
        | "scale"
        | "scale_v3"
        | "business"
        | "vercel_pg_legacy";
    };
    /**
     * The most recent time when any endpoint of this project was active.
     *
     * Omitted when observed no activity for endpoints of this project.
     *
     */
    compute_last_active_at?: string;
    org_id?: string;
    /**
     * A timestamp indicating when project update begins. If set, computes might experience a brief restart around this time.
     *
     */
    maintenance_scheduled_for?: string;
    /**
     * A timestamp indicating when HIPAA was enabled for this project
     */
    hipaa_enabled_at?: string;
  }

  export namespace Endpoint {
    /**
     * The state of the compute endpoint
     */
    export type State = "init" | "active" | "idle";

    /**
     * The compute endpoint type. Either `read_write` or `read_only`.
     */
    export type Type = "read_only" | "read_write";

    /**
     * The connection pooler mode. Neon supports PgBouncer in `transaction` mode only.
     */
    export type PoolerMode = "transaction";

    export interface Settings {
      /**
       * A raw representation of Postgres settings
       */
      pg_settings?: Record<string, string>;
      /**
       * A raw representation of PgBouncer settings
       */
      pgbouncer_settings?: Record<string, string>;
      /**
       * The shared libraries to preload into the project's compute instances.
       */
      preload_libraries?: {
        use_defaults?: boolean;
        enabled_libraries?: string[];
      };
    }
  }

  export interface Role {
    /**
     * The ID of the branch to which the role belongs
     */
    branch_id: string;
    /**
     * The role name
     */
    name: string;
    /**
     * The role password
     */
    password?: string;
    /**
     * Whether or not the role is system-protected
     */
    protected?: boolean;
    /**
     * A timestamp indicating when the role was created
     */
    created_at: string;
    /**
     * A timestamp indicating when the role was last updated
     */
    updated_at: string;
  }

  export interface ConnectionDetails {
    /**
     * The connection URI is defined as specified here: [Connection URIs](https://www.postgresql.org/docs/current/libpq-connect.html#LIBPQ-CONNSTRING-URIS)
     * The connection URI can be used to connect to a Postgres database with psql or defined in a DATABASE_URL environment variable.
     * When creating a branch from a parent with more than one role or database, the response body does not include a connection URI.
     *
     */
    connection_uri: string;
    connection_parameters: {
      /**
       * Database name
       */
      database: string;
      /**
       * Password for the role
       */
      password: string;
      /**
       * Role name
       */
      role: string;
      /**
       * Hostname
       */
      host: string;
      /**
       * Pooler hostname
       */
      pooler_host: string;
    };
  }

  export interface Operation {
    /**
     * The operation ID
     */
    id: string;
    /**
     * The Neon project ID
     */
    project_id: string;
    /**
     * The branch ID
     */
    branch_id?: string;
    /**
     * The endpoint ID
     */
    endpoint_id?: string;
    action: Operation.Action;
    status: Operation.Status;
    /**
     * The error that occurred
     */
    error?: string;
    /**
     * The number of times the operation failed
     */
    failures_count: number;
    /**
     * A timestamp indicating when the operation was last retried
     */
    retry_at?: string;
    /**
     * A timestamp indicating when the operation was created
     */
    created_at: string;
    /**
     * A timestamp indicating when the operation status was last updated
     */
    updated_at: string;
    /**
     * The total duration of the operation in milliseconds
     */
    total_duration_ms: number;
  }

  export namespace Operation {
    export type Action =
      | "create_compute"
      | "create_timeline"
      | "start_compute"
      | "suspend_compute"
      | "apply_config"
      | "check_availability"
      | "delete_timeline"
      | "create_branch"
      | "import_data"
      | "tenant_ignore"
      | "tenant_attach"
      | "tenant_detach"
      | "tenant_reattach"
      | "replace_safekeeper"
      | "disable_maintenance"
      | "apply_storage_config"
      | "prepare_secondary_pageserver"
      | "switch_pageserver"
      | "detach_parent_branch"
      | "timeline_archive"
      | "timeline_unarchive"
      | "start_reserved_compute"
      | "sync_dbs_and_roles_from_compute"
      | "apply_schema_from_branch"
      | "timeline_mark_invisible"
      | "prewarm_replica"
      | "promote_replica";

    export type Status =
      | "scheduling"
      | "running"
      | "finished"
      | "failed"
      | "error"
      | "cancelling"
      | "cancelled"
      | "skipped";
  }
}
