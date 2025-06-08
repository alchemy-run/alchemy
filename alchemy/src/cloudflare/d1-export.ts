import { logger } from "../util/logger.ts";
import type { CloudflareApi } from "./api.ts"; // Ensure CloudflareApi is exported if not already

/**
 * Options for exporting a D1 database
 */
export interface ExportD1DatabaseOptions {
  /**
   * The ID of the D1 database to export
   */
  databaseId: string;

  /**
   * Optional dump options to control what is exported
   */
  dumpOptions?: {
    /**
     * Optional list of tables to export
     */
    tables?: string[];

    /**
     * Whether to exclude schema in the export
     */
    no_schema?: boolean;

    /**
     * Whether to exclude data in the export
     */
    no_data?: boolean;
  };
}

/**
 * Response from the export D1 database operation
 */
export interface ExportD1DatabaseResult {
  /**
   * The filename of the exported database
   */
  filename: string;

  /**
   * The signed URL for downloading the exported database
   */
  signed_url: string;

  /**
   * The status of the export operation
   */
  status: "complete";

  /**
   * Whether the export operation was successful
   */
  success: boolean;
}

/**
 * Error response from Cloudflare API
 */
interface CloudflareErrorResponse {
  error?: string;
  errors?: Array<{
    message: string;
  }>;
}

/**
 * Response during polling for D1 database export
 */
interface ExportPollingResponse {
  /**
   * Bookmark for continuing the polling process
   */
  at_bookmark?: string;

  /**
   * Error message if any
   */
  error?: string;

  /**
   * Progress messages from the export process
   */
  messages: string[];

  /**
   * Result data if export is complete
   */
  result?: {
    filename: string;
    signed_url: string;
  };

  /**
   * Status of the export process
   */
  status: "complete" | "error" | "processing";

  /**
   * Whether the current polling request was successful
   */
  success: boolean;

  /**
   * Type of operation
   */
  type: "export";
}

/**
 * Initiates an export of a Cloudflare D1 database and returns a download URL.
 * Implements recursive polling with bookmark handling, similar to wrangler.
 * Waits indefinitely until the export process completes or fails.
 *
 * Based on Cloudflare API:
 * https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/export/
 * and wrangler implementation.
 *
 * @param options Options including the database ID and optional dump parameters.
 * @returns An object containing the download URL, filename, and status upon completion.
 * @throws Will throw an error if the API call fails or the export process reports an error.
 */
export async function exportD1Database(
  api: CloudflareApi,
  options: ExportD1DatabaseOptions,
  currentBookmark?: string,
): Promise<ExportD1DatabaseResult> {
  const response = await api.post(
    `/accounts/${api.accountId}/d1/database/${options.databaseId}/export`,
    {
      output_format: "polling",
      dump_options: options.dumpOptions || {},
      current_bookmark: currentBookmark,
    },
  );

  if (!response.ok) {
    const errorData = (await response.json()) as CloudflareErrorResponse;
    throw new Error(
      `Failed to export D1 database: ${errorData.error || errorData.errors?.[0]?.message || "Unknown error"}`,
    );
  }

  const { result: data } = (await response.json()) as {
    result: ExportPollingResponse;
  };

  if (!data.success) {
    throw new Error(data.error || "Unknown error during D1 export");
  }

  // Log messages for visibility
  if (data.messages && data.messages.length > 0) {
    for (const message of data.messages) {
      logger.log(`D1 Export: ${message}`);
    }
  }

  if (data.status === "complete" && data.result) {
    return {
      filename: data.result.filename,
      signed_url: data.result.signed_url,
      status: data.status,
      success: data.success,
    };
  } else if (data.status === "error") {
    throw new Error(data.error || "Error during D1 export");
  } else {
    // Continue polling with bookmark
    return exportD1Database(api, options, data.at_bookmark);
  }
}
