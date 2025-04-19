import * as crypto from "crypto";
import * as fs from "fs/promises";
import type { Context } from "../context";
import { Bundle, type BundleProps } from "../esbuild/bundle";
import { Resource } from "../resource";
import { getContentType } from "../util/content-type";
import { withExponentialBackoff } from "../util/retry";
import { slugify } from "../util/slugify";
import {
  createCloudflareApi,
  type CloudflareApi,
  type CloudflareApiOptions,
} from "./api";
import { type Assets } from "./assets";
import { type Bindings, type WorkerBindingSpec } from "./bindings";
import type { Bound } from "./bound";
import { type DurableObjectNamespace } from "./durable-object-namespace";
import type { WorkerScriptMetadata } from "./worker-metadata";
import type { SingleStepMigration } from "./worker-migration";
import { upsertWorkflow, type Workflow } from "./workflow";

/**
 * Properties for creating or updating a Worker
 */
export interface WorkerProps<B extends Bindings = Bindings>
  extends CloudflareApiOptions {
  /**
   * The worker script content (JavaScript or WASM)
   * One of script, entryPoint, or bundle must be provided
   */
  script?: string;

  /**
   * Path to the entry point file
   * Will be bundled using esbuild
   * One of script, entryPoint, or bundle must be provided
   */
  entrypoint?: string;

  /**
   * Bundle options when using entryPoint
   * Ignored if bundle is provided
   */
  bundle?: Omit<BundleProps, "entryPoint">;

  /**
   * Module format for the worker script
   * 'esm' - ECMAScript modules (default)
   * 'cjs' - CommonJS modules
   * @default 'esm'
   */
  format?: "esm" | "cjs";

  /**
   * Name for the worker
   * This is mandatory - must be explicitly specified
   */
  name: string;

  /**
   * Bindings to attach to the worker
   */
  bindings?: B;

  /**
   * Environment variables to attach to the worker
   * These will be converted to plain_text bindings
   */
  env?: {
    [key: string]: string;
  };

  /**
   * Whether to enable a workers.dev URL for this worker
   * If true, the worker will be available at {name}.{subdomain}.workers.dev
   * @default false
   */
  url?: boolean;

  /**
   * Observability configuration for the worker
   * Controls whether worker logs are enabled
   * @default { enabled: true }
   */
  observability?: {
    /**
     * Whether to enable worker logs
     * @default true
     */
    enabled?: boolean;
  };

  /**
   * Migrations to apply to the worker
   */
  migrations?: SingleStepMigration;

  /**
   * Whether to adopt the Worker if it already exists when creating
   */
  adopt?: boolean;

  /**
   * The compatibility date for the worker
   * @default "2024-09-09"
   */
  compatibilityDate?: string;

  /**
   * The compatibility flags for the worker
   */
  compatibilityFlags?: string[];
}

/**
 * Output returned after Worker creation/update
 */
export interface Worker<B extends Bindings = Bindings>
  extends Resource<"cloudflare::Worker">,
    Omit<WorkerProps<B>, "url"> {
  type: "service";

  /**
   * The ID of the worker
   */
  id: string;

  /**
   * Time at which the worker was created
   */
  createdAt: number;

  /**
   * Time at which the worker was last updated
   */
  updatedAt: number;

  /**
   * The worker's URL if enabled
   * Format: {name}.{subdomain}.workers.dev
   */
  url?: string;

  /**
   * The bindings that were created
   */
  bindings: B | undefined;

  // phantom property (for typeof myWorker.Env)
  Env: {
    [bindingName in keyof B]: Bound<B[bindingName]>;
  };
}

/**
 * A Cloudflare Worker is a serverless function that can be deployed to the Cloudflare network.
 *
 * @example
 * // Create a basic HTTP handler worker with custom domain routing
 * // and workers.dev URL:
 * const api = await Worker("api", {
 *   name: "api-worker",
 *   entrypoint: "./src/api.ts",
 *   routes: ["api.example.com/*"],
 *   url: true
 * });
 *
 * @example
 * // Create a real-time chat worker using Durable Objects
 * // for state management:
 * const chatRooms = new DurableObjectNamespace("chat-rooms");
 * const userStore = new DurableObjectNamespace("user-store");
 *
 * const chat = await Worker("chat", {
 *   name: "chat-worker",
 *   entrypoint: "./src/chat.ts",
 *   bindings: {
 *     ROOMS: chatRooms,
 *     USERS: userStore
 *   },
 * });
 *
 * @example
 * // Create a worker with KV namespace for caching and data storage:
 * const cache = await KVNamespace("cache-store");
 * const settings = await KVNamespace("user-settings");
 *
 * const cacheWorker = await Worker("cache", {
 *   name: "cache-worker",
 *   entrypoint: "./src/cache.ts",
 *   bindings: {
 *     CACHE: cache,
 *     SETTINGS: settings
 *   }
 * });
 *
 * @example
 * // Create a worker with R2 bucket for object storage:
 * const uploads = await R2Bucket("uploads", {
 *   name: "user-uploads"
 * });
 * const assets = await R2Bucket("assets", {
 *   name: "static-assets",
 *   allowPublicAccess: true
 * });
 *
 * const storageWorker = await Worker("storage", {
 *   name: "storage-worker",
 *   entrypoint: "./src/storage.ts",
 *   bindings: {
 *     UPLOADS: uploads,
 *     ASSETS: assets
 *   }
 * });
 *
 * @example
 * // Create a worker with static assets:
 * const staticAssets = await Assets("static", {
 *   path: "./src/assets"
 * });
 *
 * const frontendWorker = await Worker("frontend", {
 *   name: "frontend-worker",
 *   entrypoint: "./src/worker.ts",
 *   bindings: {
 *     ASSETS: staticAssets
 *   }
 * });
 *
 * @see https://developers.cloudflare.com/workers/
 */
export const Worker = Resource(
  "cloudflare::Worker",
  {
    alwaysUpdate: true,
  },
  async function <const B extends Bindings>(
    this: Context<Worker<NoInfer<B>>>,
    id: string,
    props: WorkerProps<B>
  ): Promise<Worker<B>> {
    // Create Cloudflare API client with automatic account discovery
    const api = await createCloudflareApi(props);

    // Use the provided name
    const workerName = props.name;

    // Validate input - we need either script, entryPoint, or bundle
    if (!props.script && !props.entrypoint) {
      throw new Error("One of script or entryPoint must be provided");
    }

    if (this.phase === "delete") {
      await deleteWorker(this, api, workerName);
      return this.destroy();
    } else if (this.phase === "create") {
      if (!props.adopt) {
        await assertWorkerDoesNotExist(this, api, workerName);
      }
    }

    const oldBindings = await this.get<Bindings>("bindings");

    // Get the script content - either from props.script, or by bundling
    const scriptContent = props.script ?? (await bundleWorkerScript(props));

    // Find any assets bindings
    const assetsBindings: { name: string; assets: Assets }[] = [];
    const workflowsBindings: Workflow[] = [];

    if (props.bindings) {
      for (const [bindingName, binding] of Object.entries(props.bindings)) {
        if (typeof binding === "object") {
          if (binding.type === "assets") {
            assetsBindings.push({ name: bindingName, assets: binding });
          } else if (binding.type === "workflow") {
            workflowsBindings.push(binding);
          }
        }
      }
    }

    // Upload any assets and get completion tokens
    let assetUploadResult: AssetUploadResult | undefined;
    if (assetsBindings.length > 0) {
      // We'll use the first asset binding for now
      // In the future, we might want to support multiple asset bindings
      const assetBinding = assetsBindings[0];

      // Upload the assets and get the completion token
      assetUploadResult = await uploadAssets(
        api,
        workerName,
        assetBinding.assets
      );
    }

    // Prepare metadata with bindings
    const scriptMetadata = await prepareWorkerMetadata(
      this,
      oldBindings,
      props,
      assetUploadResult
    );

    await putWorker(api, workerName, scriptContent, scriptMetadata);

    for (const workflow of workflowsBindings) {
      await upsertWorkflow(api, {
        workflowName: workflow.workflowName,
        className: workflow.className,
        scriptName: workerName,
      });
    }

    // TODO: it is less than ideal that this can fail, resulting in state problem
    await this.set("bindings", props.bindings);

    // Handle worker URL if requested
    const workerUrl = await configureURL(
      this,
      api,
      workerName,
      props.url ?? false
    );

    // Get current timestamp
    const now = Date.now();

    // Construct the output
    return this({
      ...props,
      type: "service",
      id,
      entrypoint: props.entrypoint,
      name: workerName,
      script: scriptContent,
      format: props.format || "esm", // Include format in the output
      bindings: props.bindings ?? ({} as B),
      env: props.env,
      observability: scriptMetadata.observability,
      createdAt: now,
      updatedAt: now,
      url: workerUrl,
      // phantom property
      Env: undefined!,
    });
  }
);

async function deleteWorker<B extends Bindings>(
  ctx: Context<Worker<B>>,
  api: CloudflareApi,
  workerName: string
) {
  // Delete worker
  const deleteResponse = await api.delete(
    `/accounts/${api.accountId}/workers/scripts/${workerName}`
  );

  // Check for success (2xx status code)
  if (!deleteResponse.ok && deleteResponse.status !== 404) {
    const errorData: any = await deleteResponse
      .json()
      .catch(() => ({ errors: [{ message: deleteResponse.statusText }] }));
    console.error(
      "Error deleting worker:",
      errorData.errors?.[0]?.message || deleteResponse.statusText
    );
  }

  // Disable the URL if it was enabled
  if (ctx.output?.url) {
    try {
      await api.post(
        `/accounts/${api.accountId}/workers/scripts/${workerName}/subdomain`,
        JSON.stringify({ enabled: false }),
        {
          headers: { "Content-Type": "application/json" },
        }
      );
    } catch (error) {
      console.warn("Failed to disable worker URL during deletion:", error);
    }
  }

  // Return minimal output for deleted state
  return;
}

async function putWorker(
  api: CloudflareApi,
  workerName: string,
  scriptContent: string,
  scriptMetadata: WorkerMetadata
) {
  return withExponentialBackoff(
    async () => {
      const scriptName =
        scriptMetadata.main_module ?? scriptMetadata.body_part!;

      // Create FormData for the upload
      const formData = new FormData();

      // Add the actual script content as a named file part
      formData.append(
        scriptName,
        new Blob([scriptContent], {
          type: scriptMetadata.main_module
            ? "application/javascript+module"
            : "application/javascript",
        }),
        scriptName
      );

      // Add metadata as JSON
      formData.append(
        "metadata",
        new Blob([JSON.stringify(scriptMetadata)], {
          type: "application/json",
        })
      );

      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Upload worker script with bindings
      const uploadResponse = await api.put(
        `/accounts/${api.accountId}/workers/scripts/${workerName}`,
        formData,
        {
          headers: {
            "Content-Type": "multipart/form-data",
          },
        }
      );

      // Check if the upload was successful
      if (!uploadResponse.ok) {
        const errorData: any = await uploadResponse
          .json()
          .catch(() => ({ errors: [{ message: uploadResponse.statusText }] }));

        const errorMessage = `Error (HTTP ${uploadResponse.status}) uploading worker script '${workerName}': ${errorData.errors?.[0]?.message || uploadResponse.statusText}`;

        if (
          uploadResponse.status === 400 &&
          errorMessage.includes("not found")
        ) {
          throw new NotFoundError(errorMessage);
        }
        throw new Error(errorMessage);
      }

      return formData;
    },
    (err) => err instanceof NotFoundError,
    10,
    100
  );
}

class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

interface WorkerMetadata {
  compatibility_date: string;
  compatibility_flags?: string[];
  bindings: WorkerBindingSpec[];
  observability: {
    enabled: boolean;
  };
  migrations?: SingleStepMigration;
  main_module?: string;
  body_part?: string;
  tags?: string[];
  assets?: {
    jwt?: string;
    keep_assets?: boolean;
    config?: {
      html_handling?: "auto-trailing-slash" | "none";
      not_found_handling?: "none" | "fall-through";
    };
  };
}

interface AssetUploadResult {
  completionToken: string;
  assetConfig?: {
    html_handling?: "auto-trailing-slash" | "none";
    not_found_handling?: "none" | "fall-through";
  };
}

async function prepareWorkerMetadata<B extends Bindings>(
  ctx: Context<Worker<B>>,
  oldBindings: Bindings | undefined,
  props: WorkerProps,
  assetUploadResult?: AssetUploadResult
): Promise<WorkerMetadata> {
  // Prepare metadata with bindings
  const meta: WorkerMetadata = {
    compatibility_date: props.compatibilityDate ?? "2024-09-09",
    compatibility_flags: props.compatibilityFlags,
    bindings: [],
    observability: {
      enabled: props.observability?.enabled !== false,
    },
    // TODO(sam): base64 encode instead? 0 collision risk vs readability.
    tags: [`alchemy:id:${slugify(ctx.fqn)}`],
    migrations: {
      new_classes: props.migrations?.new_classes ?? [],
      deleted_classes: props.migrations?.deleted_classes ?? [],
      renamed_classes: props.migrations?.renamed_classes ?? [],
      transferred_classes: props.migrations?.transferred_classes ?? [],
      new_sqlite_classes: props.migrations?.new_sqlite_classes ?? [],
    },
  };

  // If we have asset upload results, add them to the metadata
  if (assetUploadResult) {
    meta.assets = {
      jwt: assetUploadResult.completionToken,
    };

    if (assetUploadResult.assetConfig) {
      meta.assets.config = assetUploadResult.assetConfig;
    }
  }

  const bindings = (props.bindings ?? {}) as Bindings;

  // Convert bindings to the format expected by the API
  for (const [bindingName, binding] of Object.entries(bindings)) {
    // Create a copy of the binding to avoid modifying the original

    if (typeof binding === "string") {
      meta.bindings.push({
        type: "plain_text",
        name: bindingName,
        text: binding,
      });
    } else if (binding.type === "d1") {
      meta.bindings.push({
        type: "d1",
        name: bindingName,
        id: binding.id,
      });
    } else if (binding.type === "kv_namespace") {
      meta.bindings.push({
        type: "kv_namespace",
        name: bindingName,
        namespace_id: binding.namespaceId,
      });
    } else if (binding.type === "service") {
      meta.bindings.push({
        type: "service",
        name: bindingName,
        service: binding.id,
      });
    } else if (binding.type === "durable_object_namespace") {
      meta.bindings.push({
        type: "durable_object_namespace",
        name: bindingName,
        class_name: binding.className,
        script_name: binding.scriptName,
        environment: binding.environment,
        namespace_id: binding.namespaceId,
      });
      configureClassMigration(binding, binding.id, binding.className);
    } else if (binding.type === "r2_bucket") {
      meta.bindings.push({
        type: "r2_bucket",
        name: bindingName,
        bucket_name: binding.name,
      });
    } else if (binding.type === "assets") {
      meta.bindings.push({
        type: "assets",
        name: bindingName,
      });
    } else if (binding.type === "secret") {
      meta.bindings.push({
        type: "secret_text",
        name: bindingName,
        text: binding.unencrypted,
      });
    } else if (binding.type === "workflow") {
      meta.bindings.push({
        type: "workflow",
        name: bindingName,
        workflow_name: binding.workflowName,
        class_name: binding.className,
        // this should be set if the Workflow is in another script ...
        // script_name: ??,
      });
      // it's unclear whether this is needed, but it works both ways
      configureClassMigration(binding, binding.id, binding.className);
    } else if (binding.type === "queue") {
      meta.bindings.push({
        type: "queue",
        name: bindingName,
        queue_name: binding.name,
      });
    } else if (binding.type === "pipeline") {
      meta.bindings.push({
        type: "pipelines",
        name: bindingName,
        pipeline: binding.name,
      });
    } else if (binding.type === "vectorize") {
      meta.bindings.push({
        type: "vectorize",
        name: bindingName,
        index_name: binding.name,
      });
    } else {
      // @ts-expect-error - we should never reach here
      throw new Error(`Unsupported binding type: ${binding.type}`);
    }
  }

  function configureClassMigration(
    binding: DurableObjectNamespace | Workflow,
    stableId: string,
    className: string
  ) {
    const oldBinding: DurableObjectNamespace | Workflow | undefined =
      Object.values(oldBindings ?? {})
        ?.filter(
          (b) =>
            typeof b === "object" &&
            (b.type === "durable_object_namespace" || b.type === "workflow")
        )
        ?.find((b) => b.id === stableId);

    if (!oldBinding) {
      if (binding.type === "durable_object_namespace" && binding.sqlite) {
        meta.migrations!.new_sqlite_classes!.push(className);
      } else {
        meta.migrations!.new_classes!.push(className);
      }
    } else if (oldBinding.className !== className) {
      meta.migrations!.renamed_classes!.push({
        from: oldBinding.className,
        to: className,
      });
    }
  }

  // Convert env variables to plain_text bindings
  // TODO(sam): remove Worker.env in favor of always bindings
  if (props.env) {
    for (const [key, value] of Object.entries(props.env)) {
      meta.bindings.push({
        name: key,
        type: "plain_text",
        text: value,
      });
    }
  }

  // Determine if we're using ESM or service worker format
  const isEsModule = props.format !== "cjs"; // Default to ESM unless CJS is specified
  const scriptName = isEsModule ? "worker.js" : "script";

  if (isEsModule) {
    // For ES modules format
    meta.main_module = scriptName;
  } else {
    // For service worker format (CJS)
    meta.body_part = scriptName;
  }
  return meta;
}

async function assertWorkerDoesNotExist<B extends Bindings>(
  ctx: Context<Worker<B>>,
  api: CloudflareApi,
  workerName: string
) {
  const response = await api.get(
    `/accounts/${api.accountId}/workers/scripts/${workerName}`
  );
  if (response.status === 404) {
    return true;
  }
  if (response.status === 200) {
    const metadata = await getWorkerScriptMetadata(api, workerName);

    if (!metadata) {
      throw new Error(
        `Worker exists but failed to fetch metadata: ${response.status} ${response.statusText}`
      );
    }

    if (
      metadata.default_environment?.script.tags.includes(
        `alchemy:id:${slugify(ctx.fqn)}`
      )
    ) {
      return true;
    }

    throw new Error(
      `Worker with name '${workerName}' already exists. Please use a unique name.`
    );
  } else {
    throw new Error(
      `Error checking if worker exists: ${response.status} ${response.statusText} ${await response.text()}`
    );
  }
}

async function bundleWorkerScript<B extends Bindings>(props: WorkerProps) {
  // Get the script content - either from props.script, or by bundling

  // Create and use a Bundle resource with worker-optimized configuration
  const defaultBundleOptions: Omit<BundleProps, "entryPoint"> = {
    format: props.format === "cjs" ? "cjs" : "esm", // Use the specified format or default to ESM
    target: "es2020",
    platform: "browser",
    minify: true,
    options: {
      keepNames: true, // Important for Durable Object classes
      loader: {
        ".sql": "text",
        ".json": "json",
      },
    },
  };

  // Merge with user-provided options
  const bundleOptions = {
    ...defaultBundleOptions,
    ...(props.bundle || {}),
  };

  // Create the bundle
  const bundle = await Bundle("bundle", {
    entryPoint: props.entrypoint!,
    ...bundleOptions,
    external: [...(bundleOptions.external ?? []), "cloudflare:workers"],
  });

  try {
    return await fs.readFile(bundle.path, "utf-8");
  } catch (error) {
    console.error("Error reading bundle:", error);
    throw new Error("Error reading bundle");
  }
}

async function configureURL<B extends Bindings>(
  ctx: Context<Worker<B>>,
  api: CloudflareApi,
  workerName: string,
  url: boolean
) {
  let workerUrl;
  if (url) {
    // Enable the workers.dev subdomain for this worker
    await api.post(
      `/accounts/${api.accountId}/workers/scripts/${workerName}/subdomain`,
      { enabled: true, previews_enabled: true },
      {
        headers: { "Content-Type": "application/json" },
      }
    );

    // Get the account's workers.dev subdomain
    const subdomainResponse = await api.get(
      `/accounts/${api.accountId}/workers/subdomain`
    );

    if (!subdomainResponse.ok) {
      throw new Error(
        `Could not fetch workers.dev subdomain: ${subdomainResponse.status} ${subdomainResponse.statusText}`
      );
    }
    const subdomainData: {
      result: {
        subdomain: string;
      };
    } = await subdomainResponse.json();
    const subdomain = subdomainData.result?.subdomain;

    if (subdomain) {
      workerUrl = `https://${workerName}.${subdomain}.workers.dev`;

      // Add a delay when the subdomain is first created.
      // This is to prevent an issue where a negative cache-hit
      // causes the subdomain to be unavailable for 30 seconds.
      if (ctx.phase === "create" || !ctx.output?.url) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
  } else if (url === false && ctx.output?.url) {
    // Explicitly disable URL if it was previously enabled
    const response = await api.post(
      `/accounts/${api.accountId}/workers/scripts/${workerName}/subdomain`,
      JSON.stringify({ enabled: false }),
      {
        headers: { "Content-Type": "application/json" },
      }
    );
    if (!response.ok) {
      throw new Error(
        `Failed to disable worker URL: ${response.status} ${response.statusText}`
      );
    }
  }
  return workerUrl;
}

async function getWorkerScriptMetadata(
  api: CloudflareApi,
  workerName: string
): Promise<WorkerScriptMetadata | undefined> {
  const response = await api.get(
    `/accounts/${api.accountId}/workers/services/${workerName}`
  );
  if (response.status === 404) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error(
      `Error getting worker script metadata: ${response.status} ${response.statusText}`
    );
  }
  return ((await response.json()) as any).result as WorkerScriptMetadata;
}

async function getWorkerBindings(
  api: CloudflareApi,
  workerName: string,
  environment = "production"
) {
  const response = await api.get(
    `/accounts/${api.accountId}/workers/services/${workerName}/environments/${environment}/bindings`,
    {
      headers: {
        Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );

  if (response.status === 404) {
    return undefined;
  }

  if (!response.ok) {
    throw new Error(
      `Failed to fetch bindings: ${response.status} ${response.statusText}`
    );
  }

  const data: any = await response.json();

  return data.result;
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
 * @returns Completion token for the assets upload
 */
async function uploadAssets(
  api: CloudflareApi,
  workerName: string,
  assets: Assets
): Promise<AssetUploadResult> {
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
    }
  );

  if (!uploadSessionResponse.ok) {
    throw new Error(
      `Failed to start assets upload session: ${uploadSessionResponse.status} ${uploadSessionResponse.statusText}`
    );
  }

  const sessionData =
    (await uploadSessionResponse.json()) as UploadSessionResponse;

  // If there are no buckets, assets are already uploaded or empty
  if (!sessionData.result.buckets || sessionData.result.buckets.length === 0) {
    return { completionToken: sessionData.result.jwt };
  }

  // Upload the files in batches as specified by the API
  let completionToken = sessionData.result.jwt;
  const buckets = sessionData.result.buckets;

  // Process each bucket of files
  for (const bucket of buckets) {
    const formData = new FormData();

    let totalBytes = 0;

    // Add each file in the bucket to the form
    for (const fileHash of bucket) {
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

      // Add the file to the form with the hash as the key and set the correct content type
      const blob = new Blob([base64Content], {
        type: getContentType(file.filePath),
      });
      totalBytes += blob.size;
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
      }
    );

    if (!uploadResponse.ok) {
      throw new Error(
        `Failed to upload asset files: ${uploadResponse.status} ${uploadResponse.statusText}`
      );
    }

    const uploadData = (await uploadResponse.json()) as UploadResponse;
    // Update the completion token for the next batch
    if (uploadData.result.jwt) {
      completionToken = uploadData.result.jwt;
    }
  }

  // Return the final completion token
  return {
    completionToken,
    assetConfig: {
      html_handling: "auto-trailing-slash",
    },
  };
}

/**
 * Calculate the SHA-256 hash and size of a file
 *
 * @param filePath Path to the file
 * @returns Hash (first 32 chars of SHA-256) and size of the file
 */
async function calculateFileMetadata(
  filePath: string
): Promise<{ hash: string; size: number }> {
  const hash = crypto.createHash("sha256");
  const fileContent = await fs.readFile(filePath);

  hash.update(fileContent);
  const fileHash = hash.digest("hex").substring(0, 32); // First 32 chars of hash

  return {
    hash: fileHash,
    size: fileContent.length,
  };
}
