import type { Context } from "../context.ts";
import { Resource } from "../resource.ts";
import { handleApiError } from "./api-error.ts";
import { extractCloudflareResult } from "./api-response.ts";
import { createCloudflareApi, type CloudflareApiOptions } from "./api.ts";

/**
 * Properties for creating or updating a Logpush Job
 */
export interface LogpushProps extends CloudflareApiOptions {
  /**
   * Zone ID or Zone object for zone-level Logpush jobs
   * Mutually exclusive with accountId
   */
  zone?: string | { id: string; name?: string };

  /**
   * Dataset to push (e.g., "http_requests", "firewall_events", "gateway_dns")
   * @see https://developers.cloudflare.com/logs/reference/log-fields/
   */
  dataset: string;

  /**
   * Destination configuration (e.g., "s3://mybucket/logs?region=us-west-2")
   * Format depends on destination type (S3, R2, GCS, Azure, etc.)
   */
  destinationConf: string;

  /**
   * Human-readable name for the job
   */
  name?: string;

  /**
   * Whether the job is enabled
   * @default true
   */
  enabled?: boolean;

  /**
   * Ownership challenge token (obtained from ownership validation)
   * Required on creation if destination ownership not yet validated
   */
  ownershipChallenge?: string;

  /**
   * Fields to include in logs (comma-separated)
   * If not specified, all available fields for the dataset are included
   */
  logpullOptions?: string;

  /**
   * Filter to apply to logs (JSON string)
   * @example '{"where":{"and":[{"key":"ClientCountry","operator":"neq","value":"ca"}]}}'
   */
  filter?: string;

  /**
   * Sampling rate (0.01 to 1.0)
   * @default 1.0 (no sampling)
   */
  sample?: number;

  /**
   * Upload frequency ("high" or "low")
   * @default "high"
   */
  frequency?: "high" | "low";

  /**
   * Maximum upload size in bytes
   */
  maxUploadBytes?: number;

  /**
   * Maximum upload interval in seconds
   */
  maxUploadIntervalSeconds?: number;

  /**
   * Maximum number of records per upload
   */
  maxUploadRecords?: number;

  /**
   * Output options for formatting logs
   */
  outputOptions?: {
    /**
     * Field delimiter
     */
    fieldDelimiter?: string;

    /**
     * Field names to include
     */
    fieldNames?: string[];

    /**
     * Output type (e.g., "ndjson", "csv")
     */
    outputType?: string;

    /**
     * Timestamp format
     */
    timestampFormat?: "unixnano" | "unix" | "rfc3339";

    /**
     * Sample rate
     */
    sampleRate?: number;
  };

  /**
   * Whether to delete the Logpush job when removed
   * @default true
   */
  delete?: boolean;
}

/**
 * Logpush Job output
 */
export interface Logpush
  extends Omit<LogpushProps, "ownershipChallenge" | "delete"> {
  /**
   * Job ID
   */
  id: number;

  /**
   * Time at which the job was created
   */
  createdAt: number;

  /**
   * Time at which the job was last modified
   */
  modifiedAt: number;

  /**
   * Last error message (if any)
   */
  errorMessage?: string;

  /**
   * Timestamp of last successful push
   */
  lastComplete?: string;

  /**
   * Timestamp of last error
   */
  lastError?: string;

  /**
   * Logpush job kind
   */
  kind?: string;

  /**
   * Account or Zone scope
   */
  scope: "account" | "zone";

  /**
   * Account ID (for account-level jobs)
   */
  accountId?: string;

  /**
   * Zone ID (for zone-level jobs)
   */
  zoneId?: string;
}

/**
 * Creates and manages Cloudflare Logpush Jobs for streaming logs to external destinations.
 *
 * Logpush jobs can be scoped to either an account or a zone, and support various
 * log datasets like HTTP requests, firewall events, DNS logs, and more.
 *
 * @example
 * // Create a zone-level Logpush job for HTTP requests to S3
 * const httpLogs = await Logpush("http-logs", {
 *   zone: "example.com",
 *   dataset: "http_requests",
 *   destinationConf: "s3://my-bucket/logs?region=us-west-2",
 *   name: "HTTP Request Logs",
 *   enabled: true,
 *   logpullOptions: "fields=RayID,ClientIP,EdgeStartTimestamp&timestamps=rfc3339"
 * });
 *
 * @example
 * // Create an account-level Logpush job for firewall events to R2
 * const firewallLogs = await Logpush("firewall-logs", {
 *   dataset: "firewall_events",
 *   destinationConf: "r2://my-bucket/firewall-logs",
 *   name: "Firewall Events",
 *   filter: '{"where":{"and":[{"key":"Action","operator":"eq","value":"block"}]}}'
 * });
 *
 * @example
 * // Create a Logpush job with sampling and custom output format
 * const sampledLogs = await Logpush("sampled-logs", {
 *   zone: myZone,
 *   dataset: "http_requests",
 *   destinationConf: "s3://logs-bucket/sampled?region=eu-west-1",
 *   sample: 0.1, // 10% sampling
 *   frequency: "low",
 *   outputOptions: {
 *     outputType: "ndjson",
 *     timestampFormat: "rfc3339",
 *     fieldNames: ["ClientIP", "ClientRequestHost", "EdgeResponseStatus"]
 *   }
 * });
 *
 * @see https://developers.cloudflare.com/logs/get-started/enable-destinations/
 * @see https://developers.cloudflare.com/api/resources/logpush/
 */
export const Logpush = Resource(
  "cloudflare::Logpush",
  async function (
    this: Context<Logpush>,
    _id: string,
    props: LogpushProps,
  ): Promise<Logpush> {
    const api = await createCloudflareApi(props);

    // Determine scope (account or zone)
    const isZoneScoped = !!props.zone;
    const scope = isZoneScoped ? "zone" : "account";

    let zoneId: string | undefined;
    let accountId: string | undefined;

    if (isZoneScoped) {
      zoneId = typeof props.zone === "string" ? props.zone : props.zone!.id;
    } else {
      accountId = api.accountId;
    }

    // Build API path
    const basePath = isZoneScoped
      ? `/zones/${zoneId}/logpush/jobs`
      : `/accounts/${accountId}/logpush/jobs`;

    if (this.phase === "delete") {
      if (this.output?.id && props.delete !== false) {
        const deleteResponse = await api.delete(
          `${basePath}/${this.output.id}`,
        );

        if (!deleteResponse.ok && deleteResponse.status !== 404) {
          await handleApiError(
            deleteResponse,
            "delete",
            "logpush_job",
            String(this.output.id),
          );
        }
      }
      return this.destroy();
    }

    // Prepare job configuration
    const jobConfig = {
      dataset: props.dataset,
      destination_conf: props.destinationConf,
      ...(props.name && { name: props.name }),
      ...(props.enabled !== undefined && { enabled: props.enabled }),
      ...(props.logpullOptions && { logpull_options: props.logpullOptions }),
      ...(props.filter && { filter: props.filter }),
      ...(props.sample !== undefined && { sample: props.sample }),
      ...(props.frequency && { frequency: props.frequency }),
      ...(props.maxUploadBytes && { max_upload_bytes: props.maxUploadBytes }),
      ...(props.maxUploadIntervalSeconds && {
        max_upload_interval_seconds: props.maxUploadIntervalSeconds,
      }),
      ...(props.maxUploadRecords && {
        max_upload_records: props.maxUploadRecords,
      }),
      ...(props.outputOptions && { output_options: props.outputOptions }),
      ...(props.ownershipChallenge && {
        ownership_challenge: props.ownershipChallenge,
      }),
    };

    let jobData: any;

    if (this.phase === "update" && this.output?.id) {
      // Update existing job
      jobData = await extractCloudflareResult<any>(
        `update logpush job ${this.output.id}`,
        api.put(`${basePath}/${this.output.id}`, jobConfig),
      );
    } else {
      // Create new job
      jobData = await extractCloudflareResult<any>(
        `create logpush job for dataset ${props.dataset}`,
        api.post(basePath, jobConfig),
      );
    }

    return {
      id: jobData.id,
      scope,
      ...(zoneId && { zoneId }),
      ...(accountId && { accountId }),
      dataset: jobData.dataset,
      destinationConf: jobData.destination_conf,
      name: jobData.name,
      enabled: jobData.enabled ?? true,
      logpullOptions: jobData.logpull_options,
      filter: jobData.filter,
      sample: jobData.sample,
      frequency: jobData.frequency,
      maxUploadBytes: jobData.max_upload_bytes,
      maxUploadIntervalSeconds: jobData.max_upload_interval_seconds,
      maxUploadRecords: jobData.max_upload_records,
      outputOptions: jobData.output_options,
      errorMessage: jobData.error_message,
      lastComplete: jobData.last_complete,
      lastError: jobData.last_error,
      kind: jobData.kind,
      createdAt: this.output?.createdAt ?? Date.now(),
      modifiedAt: Date.now(),
    };
  },
);
