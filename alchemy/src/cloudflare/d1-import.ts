import { createHash } from "node:crypto";
import { logger } from "../util/logger.ts";
import type { CloudflareApi } from "./api.ts";

/**
 * Options for importing SQL into a D1 database
 */
export interface ImportD1DatabaseOptions {
  /**
   * The ID of the D1 database to import into
   */
  databaseId: string;

  /**
   * The SQL file data to upload
   */
  sqlData: Blob | BufferSource | string;

  /**
   * Optional custom filename for the imported SQL
   */
  filename?: string;
}

/**
 * Response from the import D1 database operation
 */
export interface ImportD1DatabaseResult {
  /**
   * The filename of the imported database
   */
  filename: string;

  /**
   * Additional result information from the import operation
   */
  result: {
    /**
     * Final bookmark used during import
     */
    final_bookmark?: string;

    /**
     * Metadata about the import operation
     */
    meta: {
      /**
       * Whether the database was changed
       */
      changed_db: boolean;

      /**
       * Number of changes made
       */
      changes: number;

      /**
       * Duration of the operation
       */
      duration: number;

      /**
       * ID of the last row
       */
      last_row_id: number;

      /**
       * Number of rows read
       */
      rows_read: number;

      /**
       * Number of rows written
       */
      rows_written: number;

      /**
       * Whether served by primary
       */
      served_by_primary: boolean;

      /**
       * Region that served the request
       */
      served_by_region: string;

      /**
       * Size after import
       */
      size_after: number;

      /**
       * Timing information
       */
      timings: {
        /**
         * SQL execution duration in milliseconds
         */
        sql_duration_ms: number;
      };
    };

    /**
     * Number of queries executed
     */
    num_queries: number;
  };

  /**
   * The status of the import operation
   */
  status: "complete";

  /**
   * Whether the import operation was successful
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
 * Response during polling for D1 database import
 */
interface ImportPollingResponse {
  /**
   * Bookmark for continuing the polling process
   */
  at_bookmark?: string;

  /**
   * Error message if any
   */
  error?: string;

  /**
   * The filename of the imported SQL
   */
  filename?: string;

  /**
   * Progress messages from the export process
   */
  messages: string[];

  /**
   * Result data if import is complete
   */
  result?: {
    final_bookmark?: string;
    meta: {
      changed_db: boolean;
      changes: number;
      duration: number;
      last_row_id: number;
      rows_read: number;
      rows_written: number;
      served_by_primary: boolean;
      served_by_region: string;
      size_after: number;
      timings: {
        sql_duration_ms: number;
      };
    };
    num_queries: number;
  };

  /**
   * Status of the import process
   */
  status: "complete" | "error" | "processing";

  /**
   * Whether the current polling request was successful
   */
  success: boolean;

  /**
   * Type of operation
   */
  type: "import";

  /**
   * The URL to upload the SQL file to
   */
  upload_url?: string;
}

/**
 * Cloudflare API response structure
 */
interface CloudflareApiResponse<T> {
  result: T;
  success: boolean;
  errors: Array<{
    message: string;
  }>;
  messages: Array<{
    message: string;
  }>;
}

/**
 * Calculates MD5 hash for a string
 */
function getMd5Hash(data: string): string {
  return createHash("md5").update(data).digest("hex");
}

/**
 * Initiates an import of SQL into a Cloudflare D1 database.
 * Implements a flow to get an upload URL, upload the SQL file, and poll for status updates.
 *
 * Based on Cloudflare API:
 * https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/import/
 *
 * @param api The CloudflareApi instance to use for requests
 * @param options Options including the database ID and SQL data to import
 * @returns An object containing the import results and status upon completion
 * @throws Will throw an error if the API call fails or the import process reports an error
 */
export async function importD1Database(
  api: CloudflareApi,
  options: ImportD1DatabaseOptions,
): Promise<ImportD1DatabaseResult> {
  // Convert data to string for hashing if it's not already
  let sqlDataString: string;
  if (typeof options.sqlData === "string") {
    sqlDataString = options.sqlData;
  } else if (options.sqlData instanceof Blob) {
    sqlDataString = await options.sqlData.text();
  } else {
    // BufferSource (ArrayBuffer, etc.)
    sqlDataString = new TextDecoder().decode(options.sqlData);
  }

  // Calculate MD5 hash of SQL data
  const etag = getMd5Hash(sqlDataString);

  // Step 1: Initialize the import process to get an upload URL
  const initResponse = await api.post(
    `/accounts/${api.accountId}/d1/database/${options.databaseId}/import`,
    {
      action: "init",
      etag,
    },
  );

  if (!initResponse.ok) {
    const errorData = (await initResponse.json()) as CloudflareErrorResponse;
    throw new Error(
      `Failed to initialize D1 database import: ${errorData.error || errorData.errors?.[0]?.message || "Unknown error"}`,
    );
  }

  const initData =
    (await initResponse.json()) as CloudflareApiResponse<ImportPollingResponse>;

  const uploadResult = initData.result;
  if (!uploadResult.success || !uploadResult.upload_url) {
    throw new Error(
      uploadResult.error || "Failed to get upload URL for D1 import",
    );
  }

  // Step 2: Upload the SQL file
  await uploadSqlFile(
    uploadResult.upload_url,
    options.sqlData,
    options.filename || uploadResult.filename,
  );

  // Step 3: Ingest the uploaded file
  const ingestResponse = await api.post(
    `/accounts/${api.accountId}/d1/database/${options.databaseId}/import`,
    {
      action: "ingest",
      etag,
      filename: uploadResult.filename,
    },
  );

  if (!ingestResponse.ok) {
    const errorData = (await ingestResponse.json()) as CloudflareErrorResponse;
    throw new Error(
      `Failed to ingest D1 database upload: ${errorData.error || errorData.errors?.[0]?.message || "Unknown error"}`,
    );
  }

  const ingestData =
    (await ingestResponse.json()) as CloudflareApiResponse<ImportPollingResponse>;

  const ingestResult = ingestData.result;
  if (!ingestResult.success) {
    throw new Error(
      ingestResult.error || "Failed to start ingestion for D1 import",
    );
  }

  if (!ingestResult.at_bookmark) {
    throw new Error("Ingest response did not contain a bookmark for polling");
  }

  // Step 4: Poll for status
  return pollImportStatus(api, options.databaseId, ingestResult.at_bookmark);
}

/**
 * Uploads an SQL file to the provided URL
 */
async function uploadSqlFile(
  uploadUrl: string,
  sqlData: Blob | BufferSource | string,
  filename?: string,
): Promise<void> {
  // Convert data to the right format if needed
  let blob: Blob;
  if (typeof sqlData === "string") {
    blob = new Blob([sqlData], { type: "application/sql" });
  } else if (sqlData instanceof Blob) {
    blob = sqlData;
  } else {
    // BufferSource (ArrayBuffer, etc.)
    blob = new Blob([sqlData], { type: "application/sql" });
  }

  // Create a FormData object with the file
  const formData = new FormData();
  formData.append("file", blob, filename || "import.sql");

  const response = await fetch(uploadUrl, {
    method: "PUT",
    body: blob,
    headers: {
      "Content-Type": "application/sql",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to upload SQL file: ${response.statusText}`);
  }
}

/**
 * Polls for the import status with the provided bookmark
 */
async function pollImportStatus(
  api: CloudflareApi,
  databaseId: string,
  bookmark?: string,
): Promise<ImportD1DatabaseResult> {
  if (!bookmark) {
    throw new Error("Cannot poll an import without a bookmark");
  }

  const response = await api.post(
    `/accounts/${api.accountId}/d1/database/${databaseId}/import`,
    {
      action: "poll",
      current_bookmark: bookmark,
    },
  );

  if (!response.ok) {
    const errorData = (await response.json()) as CloudflareErrorResponse;
    throw new Error(
      `Failed to poll D1 import status: ${errorData.error || errorData.errors?.[0]?.message || "Unknown error"}`,
    );
  }

  const data = (
    (await response.json()) as CloudflareApiResponse<ImportPollingResponse>
  ).result;

  if (!data.success) {
    throw new Error(data.error || "Unknown error during D1 import");
  }

  // Log messages for visibility
  if (data.messages && data.messages.length > 0) {
    for (const message of data.messages) {
      logger.log(`D1 Import: ${message}`);
    }
  }

  if (data.status === "complete" && data.result) {
    return {
      filename: data.filename || "import.sql",
      result: data.result,
      status: data.status,
      success: data.success,
    };
  } else if (data.status === "error") {
    throw new Error(data.error || "Error during D1 import");
  } else {
    // Continue polling with bookmark
    return pollImportStatus(api, databaseId, data.at_bookmark);
  }
}
