import { isDeepStrictEqual } from "node:util";
import type { Context } from "../context.ts";
import { Resource, ResourceKind } from "../resource.ts";
import { Scope } from "../scope.ts";
import { withExponentialBackoff } from "../util/retry.ts";
import { CloudflareApiError } from "./api-error.ts";
import {
  extractCloudflareError,
  extractCloudflareResult,
} from "./api-response.ts";
import {
  createCloudflareApi,
  type CloudflareApi,
  type CloudflareApiOptions,
} from "./api.ts";

/**
 * Properties for creating or updating an R2 Bucket
 */
export interface BucketProps extends CloudflareApiOptions {
  /**
   * Name of the bucket
   * Names can only contain lowercase letters (a-z), numbers (0-9), and hyphens (-)
   * Cannot begin or end with a hyphen
   *
   * @default - the id of the resource
   */
  name?: string;

  /**
   * Optional location hint for the bucket
   * Indicates the primary geographical location data will be accessed from
   */
  locationHint?: string;

  /**
   * Optional storage class for the bucket
   * Indicates the storage class for the bucket
   */
  storageClass?: "Standard" | "InfrequentAccess";

  /**
   * Optional jurisdiction for the bucket
   * Determines the regulatory jurisdiction the bucket data falls under
   */
  jurisdiction?: "default" | "eu" | "fedramp";

  /**
   * Whether to allow public access through the r2.dev subdomain
   * Only for development purposes - use custom domains for production
   */
  allowPublicAccess?: boolean;

  /**
   * Whether to delete the bucket.
   * If set to false, the bucket will remain but the resource will be removed from state
   *
   * @default true
   */
  delete?: boolean;

  /**
   * Whether to empty the bucket and delete all objects during resource deletion
   * @default false
   */
  empty?: boolean;

  /**
   * Whether to adopt an existing bucket
   */
  adopt?: boolean;

  /**
   * CORS rules for the bucket
   */
  cors?: R2BucketCORSRule[];

  /**
   * Whether to emulate the bucket locally when Alchemy is running in watch mode.
   */
  dev?: {
    /**
     * Whether to run the bucket remotely instead of locally
     * @default false
     */
    remote?: boolean;

    /**
     * Set when `Scope.local` is true to force update to the bucket even if it was already deployed live.
     * @internal
     */
    force?: boolean;
  };
}

interface R2BucketCORSRule {
  /**
   * Identifier for this rule.
   */
  id?: string;

  /**
   * Object specifying allowed origins, methods and headers for this CORS rule.
   */
  allowed: {
    /**
     * Specifies the value for the Access-Control-Allow-Methods header R2 sets when requesting objects in a bucket from a browser.
     */
    methods: ("GET" | "PUT" | "POST" | "DELETE" | "HEAD")[];

    /**
     * Specifies the value for the Access-Control-Allow-Origin header R2 sets when requesting objects in a bucket from a browser.
     */
    origins: string[];

    /**
     * Specifies the value for the Access-Control-Allow-Headers header R2 sets when requesting objects in this bucket from a browser. Cross-origin requests that include custom headers (e.g. x-user-id) should specify these headers as AllowedHeaders.
     */
    headers?: string[];
  };

  /**
   * Specifies the headers that can be exposed back, and accessed by, the JavaScript making the cross-origin request. If you need to access headers beyond the safelisted response headers, such as Content-Encoding or cf-cache-status, you must specify it here.
   */
  exposeHeaders?: string[];

  /**
   * Specifies the amount of time (in seconds) browsers are allowed to cache CORS preflight responses. Browsers may limit this to 2 hours or less, even if the maximum value (86400) is specified.
   */
  maxAgeSeconds?: number;
}

/**
 * Output returned after R2 Bucket creation/update
 */
export type R2Bucket = Resource<"cloudflare::R2Bucket"> &
  Omit<BucketProps, "delete" | "dev"> & {
    /**
     * Resource type identifier
     */
    type: "r2_bucket";

    /**
     * The name of the bucket
     */
    name: string;

    /**
     * Location of the bucket
     */
    location: string;

    /**
     * Time at which the bucket was created
     */
    creationDate: Date;

    /**
     * The `r2.dev` subdomain for the bucket, if `allowPublicAccess` is true
     */
    domain: string | undefined;

    /**
     * Development mode properties
     * @internal
     */
    dev: {
      /**
       * The ID of the bucket in development mode
       */
      id: string;

      /**
       * Whether the bucket is running remotely
       */
      remote: boolean;
    };
  };

export function isBucket(resource: Resource): resource is R2Bucket {
  return resource[ResourceKind] === "cloudflare::R2Bucket";
}

/**
 * Creates and manages Cloudflare R2 Buckets for object storage.
 *
 * R2 Buckets provide S3-compatible object storage with automatic data replication
 * across multiple regions for high availability and durability.
 *
 * @example
 * // Create a basic R2 bucket with default settings
 * const basicBucket = await R2Bucket("my-app-data", {
 *   name: "my-app-data"
 * });
 *
 * @example
 * // Create a bucket with location hint for optimal performance
 * const euBucket = await R2Bucket("eu-user-data", {
 *   name: "eu-user-data",
 *   locationHint: "eu",
 *   jurisdiction: "eu"
 * });
 *
 * @example
 * // Create a development bucket with public access enabled
 * const publicBucket = await R2Bucket("public-assets", {
 *   name: "public-assets",
 *   allowPublicAccess: true
 * });
 *
 * @example
 * // Create a FedRAMP compliant bucket for government workloads
 * const fedRampBucket = await R2Bucket("gov-data", {
 *   name: "gov-data",
 *   jurisdiction: "fedramp"
 * });
 *
 * @example
 * // Create a bucket that will be automatically emptied when deleted
 * // This will delete all objects in the bucket before deleting the bucket itself
 * const temporaryBucket = await R2Bucket("temp-storage", {
 *   name: "temp-storage",
 *   empty: true  // All objects will be deleted when this resource is destroyed
 * });
 *
 * @see https://developers.cloudflare.com/r2/buckets/
 */
export async function R2Bucket(
  id: string,
  props: BucketProps = {},
): Promise<R2Bucket> {
  return await _R2Bucket(id, {
    ...props,
    dev: {
      ...(props.dev ?? {}),
      force: Scope.current.local,
    },
  });
}

const _R2Bucket = Resource(
  "cloudflare::R2Bucket",
  async function (
    this: Context<R2Bucket>,
    id: string,
    props: BucketProps = {},
  ): Promise<R2Bucket> {
    const bucketName = props.name || id;
    const allowPublicAccess = props.allowPublicAccess === true;
    const dev = {
      id: this.output?.dev?.id ?? bucketName,
      remote: props.dev?.remote ?? false,
    };

    if (this.scope.local && !props.dev?.remote) {
      return this({
        name: this.output?.name ?? "",
        location: this.output?.location ?? "",
        creationDate: this.output?.creationDate ?? new Date(),
        jurisdiction: this.output?.jurisdiction ?? "default",
        allowPublicAccess,
        domain: this.output?.domain,
        type: "r2_bucket",
        accountId: this.output?.accountId ?? "",
        cors: props.cors,
        dev,
      });
    }

    const api = await createCloudflareApi(props);

    if (this.phase === "delete") {
      if (props.delete !== false) {
        if (props.empty) {
          await emptyBucket(api, bucketName, props);
        }
        await deleteBucket(api, bucketName, props);
      }
      return this.destroy();
    }

    if (this.phase === "create" || !this.output?.name) {
      const bucket = await createBucket(api, bucketName, props).catch(
        async (err) => {
          if (
            err instanceof CloudflareApiError &&
            err.status === 409 &&
            props.adopt
          ) {
            return await getBucket(api, bucketName, props);
          }
          throw err;
        },
      );
      const domain = await putManagedDomain(
        api,
        bucketName,
        allowPublicAccess,
        props.jurisdiction,
      );
      if (props.cors?.length) {
        await putBucketCORS(api, bucketName, props);
      }
      return this({
        name: bucketName,
        location: bucket.location,
        creationDate: new Date(bucket.creation_date),
        jurisdiction: bucket.jurisdiction,
        allowPublicAccess,
        domain,
        type: "r2_bucket",
        accountId: api.accountId,
        cors: props.cors,
        dev,
      });
    } else {
      if (bucketName !== this.output.name) {
        throw new Error(
          `Cannot update R2Bucket name after creation. Bucket name is immutable. Before: ${this.output.name}, After: ${bucketName}`,
        );
      }
      let domain = this.output.domain;
      if (!!domain !== allowPublicAccess) {
        domain = await putManagedDomain(
          api,
          bucketName,
          allowPublicAccess,
          props.jurisdiction,
        );
      }
      if (!isDeepStrictEqual(this.output.cors ?? [], props.cors ?? [])) {
        await putBucketCORS(api, bucketName, props);
      }
      return this({
        ...this.output,
        allowPublicAccess,
        dev,
        cors: props.cors,
        domain,
      });
    }
  },
);

/**
 * The bucket information returned from the Cloudflare REST API
 * @see https://developers.cloudflare.com/api/node/resources/r2/subresources/buckets/models/bucket/#(schema)
 */
interface R2BucketResult {
  creation_date: string;
  location: "apac" | "eeur" | "enam" | "weur" | "wnam" | "oc";
  name: string;
  storage_class: "Standard" | "InfrequentAccess";
  jurisdiction: "default" | "eu" | "fedramp";
}

/**
 * Adds jurisdiction header to the headers object if specified in props
 *
 * @param headers Headers object to modify
 * @param props Props or jurisdiction string
 * @returns Modified headers object
 */
export function withJurisdiction(
  props: { jurisdiction?: string },
  headers: Record<string, string> = {},
): Record<string, string> {
  if (props.jurisdiction && props.jurisdiction !== "default") {
    headers["cf-r2-jurisdiction"] = props.jurisdiction;
  }

  return headers;
}

/**
 * Get a bucket
 */
export async function getBucket(
  api: CloudflareApi,
  bucketName: string,
  props: BucketProps = {},
): Promise<R2BucketResult> {
  return await extractCloudflareResult<R2BucketResult>(
    `get R2 bucket "${bucketName}"`,
    api.get(`/accounts/${api.accountId}/r2/buckets/${bucketName}`, {
      headers: withJurisdiction(props),
    }),
  );
}

/**
 * Create a new bucket
 */
export async function createBucket(
  api: CloudflareApi,
  bucketName: string,
  props: BucketProps = {},
): Promise<R2BucketResult> {
  return await extractCloudflareResult<R2BucketResult>(
    `create R2 bucket "${bucketName}"`,
    api.post(
      `/accounts/${api.accountId}/r2/buckets`,
      {
        name: bucketName,
        locationHint: props.locationHint,
        storageClass: props.storageClass,
      },
      {
        headers: withJurisdiction(props),
      },
    ),
  );
}

/**
 * Delete a bucket
 */
export async function deleteBucket(
  api: CloudflareApi,
  bucketName: string,
  props: BucketProps,
) {
  try {
    await extractCloudflareResult(
      `delete R2 bucket "${bucketName}"`,
      api.delete(`/accounts/${api.accountId}/r2/buckets/${bucketName}`, {
        headers: withJurisdiction(props),
      }),
    );
  } catch (error) {
    if (error instanceof CloudflareApiError && error.status === 404) {
      return;
    }
    throw error;
  }
}

/**
 * Update the managed domain setting for a bucket
 */
export async function putManagedDomain(
  api: CloudflareApi,
  bucketName: string,
  enabled: boolean,
  jurisdiction?: string,
) {
  return await withExponentialBackoff(
    async () => {
      const result = await extractCloudflareResult<{
        bucketId: string;
        domain: string;
        enabled: boolean;
      }>(
        `put R2 bucket managed domain for "${bucketName}"`,
        api.put(
          `/accounts/${api.accountId}/r2/buckets/${bucketName}/domains/managed`,
          { enabled },
          { headers: withJurisdiction({ jurisdiction }) },
        ),
      );
      return result.enabled ? result.domain : undefined;
    },
    (err) => err.status === 404,
    10,
    1000,
  );
}

/**
 * Delete all objects in a bucket
 */
async function emptyBucket(
  api: CloudflareApi,
  bucketName: string,
  props: BucketProps,
) {
  let batch: Promise<unknown>[] = [];
  for await (const key of listObjects(api, bucketName, props)) {
    batch.push(
      extractCloudflareResult(
        `delete R2 object "${key}"`,
        api.delete(
          `/accounts/${api.accountId}/r2/buckets/${bucketName}/objects/${key}`,
          { headers: withJurisdiction(props) },
        ),
      ),
    );
    if (batch.length >= 10) {
      // this is an arbitary batch size, open to feedback
      await Promise.all(batch);
      batch = [];
    }
  }
  await Promise.all(batch);
}

/**
 * Returns an async iterable of all object keys in a bucket,
 * handling pagination automatically.
 */
export async function* listObjects(
  api: CloudflareApi,
  bucketName: string,
  props: { jurisdiction?: string },
  cursor?: string,
): AsyncGenerator<string> {
  const params = new URLSearchParams({
    per_page: "1000",
  });
  if (cursor) {
    params.set("cursor", cursor);
  }
  const response = await api.get(
    `/accounts/${api.accountId}/r2/buckets/${bucketName}/objects?${params.toString()}`,
    { headers: withJurisdiction(props) },
  );
  if (!response.ok) {
    throw new Error(
      `Failed to list objects in bucket "${bucketName}": ${await extractCloudflareError(response)}`,
    );
  }
  const json: {
    result: { key: string }[];
    result_info?: {
      cursor: string;
      is_truncated: boolean;
      per_page: number;
    };
  } = await response.json();
  for (const object of json.result) {
    yield object.key;
  }
  if (json.result_info?.is_truncated && json.result_info.cursor) {
    yield* listObjects(api, bucketName, props, json.result_info.cursor);
  }
}

/**
 * List all R2 buckets in an account
 *
 * @param api CloudflareApi instance
 * @param options Optional listing options
 * @returns Array of bucket information
 */
export async function listBuckets(
  api: CloudflareApi,
  options: {
    nameContains?: string;
    perPage?: number;
    cursor?: string;
    direction?: "asc" | "desc";
    jurisdiction?: string;
  } = {},
) {
  // Build query parameters
  const params = new URLSearchParams();

  if (options.nameContains) {
    params.append("name_contains", options.nameContains);
  }

  if (options.perPage) {
    params.append("per_page", options.perPage.toString());
  }

  if (options.cursor) {
    params.append("cursor", options.cursor);
  }

  if (options.direction) {
    params.append("direction", options.direction);
  }

  // Build URL with query parameters
  const path = `/accounts/${api.accountId}/r2/buckets${params.toString() ? `?${params.toString()}` : ""}`;

  // Make the API request
  const result = await extractCloudflareResult<{
    buckets: { name: string; creation_date: string }[];
  }>(
    "list R2 buckets",
    api.get(path, {
      headers: withJurisdiction(options),
    }),
  );
  return result.buckets;
}

export async function putBucketCORS(
  api: CloudflareApi,
  bucketName: string,
  props: BucketProps,
) {
  let request: RequestInit;
  if (props.cors?.length) {
    request = {
      method: "PUT",
      body: JSON.stringify({ rules: props.cors }),
      headers: withJurisdiction(props, {
        "Content-Type": "application/json",
      }),
    };
  } else {
    request = {
      method: "DELETE",
      headers: withJurisdiction(props),
    };
  }
  await extractCloudflareResult(
    `${request.method} R2 bucket CORS rules for "${bucketName}"`,
    api.fetch(
      `/accounts/${api.accountId}/r2/buckets/${bucketName}/cors`,
      request,
    ),
  );
}
