import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getContentType } from "../util/content-type.ts";
import type { CloudflareApi } from "./api.ts";
import type { Assets } from "./assets.ts";
import type { AssetsConfig, WorkerProps } from "./worker.ts";

export interface AssetUploadResult {
  completionToken: string;
  assetConfig?: AssetsConfig;
}

/**
 * Interface for a file's metadata to be uploaded
 */
interface FileMetadata {
  hash: string;
  size: number;
}

/**
 * Response from the assets upload session API
 */
interface UploadSessionResponse {
  result: {
    jwt: string;
    buckets: string[][];
  };
  success: boolean;
  errors: any[];
  messages: any[];
}

/**
 * Response from the file upload API
 */
interface UploadResponse {
  result: {
    jwt: string;
    buckets?: string[][];
  };
  success: boolean;
  errors: any[];
  messages: any[];
}

/**
 * Uploads assets to Cloudflare and returns a completion token
 *
 * @param api CloudflareApi instance
 * @param workerName Name of the worker
 * @param assets Assets resource containing files to upload
 * @param assetConfig Configuration for the assets
 * @returns Completion token for the assets upload
 */
export async function uploadAssets(
  api: CloudflareApi,
  workerName: string,
  assets: Assets,
  assetConfig?: WorkerProps["assets"],
): Promise<AssetUploadResult> {
  // Process the assets configuration once at the beginning
  const processedConfig = createAssetConfig(assetConfig);

  // Generate the file manifest
  const fileMetadata: Record<string, FileMetadata> = {};

  // Process each file in the assets
  for (const file of assets.files) {
    const { hash, size } = await calculateFileMetadata(file.filePath);
    // Use the relative path as the key, ensuring it starts with a slash
    const key = file.path.startsWith("/") ? file.path : `/${file.path}`;
    fileMetadata[key] = { hash, size };
  }

  // Start the upload session
  const uploadSessionUrl = `/accounts/${api.accountId}/workers/scripts/${workerName}/assets-upload-session`;
  const uploadSessionResponse = await api.post(
    uploadSessionUrl,
    JSON.stringify({ manifest: fileMetadata }),
    {
      headers: { "Content-Type": "application/json" },
    },
  );

  if (!uploadSessionResponse.ok) {
    throw new Error(
      `Failed to start assets upload session: ${uploadSessionResponse.status} ${uploadSessionResponse.statusText}`,
    );
  }

  const sessionData =
    (await uploadSessionResponse.json()) as UploadSessionResponse;

  // If there are no buckets, assets are already uploaded or empty
  if (!sessionData.result.buckets || sessionData.result.buckets.length === 0) {
    return {
      completionToken: sessionData.result.jwt,
      assetConfig: processedConfig,
    };
  }

  // Upload the files in batches as specified by the API
  let completionToken = sessionData.result.jwt;
  const buckets = sessionData.result.buckets;

  // Process each bucket of files
  for (const bucket of buckets) {
    const formData = new FormData();

    // Prepare file reading operations for parallel execution
    const fileReadPromises = bucket.map(async (fileHash) => {
      // Find the file with this hash
      const file = assets.files.find((f) => {
        const filePath = f.path.startsWith("/") ? f.path : `/${f.path}`;
        return fileMetadata[filePath]?.hash === fileHash;
      });

      if (!file) {
        throw new Error(`Could not find file with hash ${fileHash}`);
      }

      // Read the file content
      const fileContent = await fs.readFile(file.filePath);

      // Convert to base64 as required by the API when using base64=true
      const base64Content = fileContent.toString("base64");

      return {
        fileHash,
        base64Content,
        filePath: file.filePath,
      };
    });

    // Read all files in parallel
    const fileResults = await Promise.all(fileReadPromises);

    // Add each file to the form
    for (const { fileHash, base64Content, filePath } of fileResults) {
      // Add the file to the form with the hash as the key and set the correct content type
      const blob = new Blob([base64Content], {
        // if you set application/octet-stream, you get weird `-1` errors with a message to contact support
        type: getContentType(filePath) ?? "application/null",
      });
      formData.append(fileHash, blob, fileHash);
    }

    // Upload this batch of files
    const uploadResponse = await api.post(
      `/accounts/${api.accountId}/workers/assets/upload?base64=true`,
      formData,
      {
        headers: {
          Authorization: `Bearer ${completionToken}`,
          "Content-Type": "multipart/form-data",
        },
      },
    );

    if (!uploadResponse.ok) {
      throw new Error(
        `Failed to upload asset files: ${uploadResponse.status} ${uploadResponse.statusText}`,
      );
    }

    const uploadData = (await uploadResponse.json()) as UploadResponse;
    if (!uploadData.success) {
      const error = uploadData.errors[0];
      const message = error.message;
      const code = error.code;
      throw new Error(
        `Failed to upload asset files: ${message} (Code: ${code})`,
      );
    }

    // Update the completion token for the next batch
    if (uploadData.result.jwt) {
      completionToken = uploadData.result.jwt;
    }
  }

  // Return the final completion token with asset configuration
  return {
    completionToken,
    assetConfig: processedConfig,
  };
}

/**
 * Creates asset configuration object from provided config or defaults
 */
export function createAssetConfig(config?: AssetsConfig): AssetsConfig {
  const assetConfig: AssetsConfig = {
    html_handling: "auto-trailing-slash",
  };

  if (config) {
    if (config._headers !== undefined) {
      assetConfig._headers = config._headers;
    }

    if (config._redirects !== undefined) {
      assetConfig._redirects = config._redirects;
    }

    if (config.html_handling !== undefined) {
      assetConfig.html_handling = config.html_handling;
    }

    if (config.not_found_handling !== undefined) {
      assetConfig.not_found_handling = config.not_found_handling;
    }

    if (config.run_worker_first !== undefined) {
      assetConfig.run_worker_first = config.run_worker_first;
    }

    if (config.serve_directly !== undefined) {
      assetConfig.serve_directly = config.serve_directly;
    }
  }

  return assetConfig;
}

/**
 * Calculate the SHA-256 hash and size of a file
 *
 * @param filePath Path to the file
 * @returns Hash (first 32 chars of SHA-256) and size of the file
 */
export async function calculateFileMetadata(
  filePath: string,
): Promise<{ hash: string; size: number }> {
  const contents = await fs.readFile(filePath);

  const hash = crypto.createHash("sha256");
  hash.update(contents);

  const extension = path.extname(filePath).substring(1);
  hash.update(extension);

  return {
    hash: hash.digest("hex").slice(0, 32),
    size: contents.length,
  };
}
