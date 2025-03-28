import * as fs from "fs/promises";
import type { Context } from "../context";
import { Resource } from "../resource";

/**
 * Properties for wrangler.json configuration file
 */
export interface WranglerJsonProps {
  /**
   * The name of your worker
   */
  name: string;

  /**
   * The directory containing your worker entry point
   * @default "src"
   */
  main?: string;

  /**
   * The entry point for your worker
   * @default "index.ts" or "index.js"
   */
  entrypoint?: string;

  /**
   * The directory to store build artifacts
   * @default "dist"
   */
  outdir?: string;

  /**
   * The directory to serve static assets from
   */
  assets?: string;

  /**
   * Minify the worker script
   * @default true
   */
  minify?: boolean;

  /**
   * Node.js compatibility mode
   * @default false
   */
  node_compat?: boolean;

  /**
   * First-party worker service bindings
   */
  services?: Array<{
    /**
     * Binding name
     */
    name: string;
    /**
     * Service environment
     */
    environment?: string;
  }>;

  /**
   * Worker environment variables
   */
  vars?: Record<string, string>;

  /**
   * KV Namespace bindings
   */
  kv_namespaces?: Array<{
    /**
     * Binding name
     */
    binding: string;
    /**
     * KV namespace ID
     */
    id: string;
    /**
     * Preview KV namespace ID
     */
    preview_id?: string;
  }>;

  /**
   * R2 bucket bindings
   */
  r2_buckets?: Array<{
    /**
     * Binding name
     */
    binding: string;
    /**
     * Bucket name
     */
    bucket_name: string;
    /**
     * Preview bucket name
     */
    preview_bucket_name?: string;
  }>;

  /**
   * D1 database bindings
   */
  d1_databases?: Array<{
    /**
     * Binding name
     */
    binding: string;
    /**
     * Database name
     */
    database_name: string;
    /**
     * Database ID
     */
    database_id: string;
    /**
     * Preview database ID
     */
    preview_database_id?: string;
  }>;

  /**
   * Durable Object bindings
   */
  durable_objects?: {
    /**
     * Durable Object bindings
     */
    bindings: Array<{
      /**
       * Binding name
       */
      name: string;
      /**
       * Class name
       */
      class_name: string;
      /**
       * Script name
       */
      script_name?: string;
      /**
       * Environment name
       */
      environment?: string;
    }>;
  };

  /**
   * Queue bindings
   */
  queues?: {
    /**
     * Producer bindings
     */
    producers?: Array<{
      /**
       * Binding name
       */
      binding: string;
      /**
       * Queue name
       */
      queue: string;
    }>;
    /**
     * Consumer configuration
     */
    consumers?: Array<{
      /**
       * Queue name
       */
      queue: string;
      /**
       * Maximum batch size
       */
      max_batch_size?: number;
      /**
       * Maximum batch timeout
       */
      max_batch_timeout?: number;
      /**
       * Maximum retries
       */
      max_retries?: number;
      /**
       * Dead letter queue
       */
      dead_letter_queue?: string;
    }>;
  };

  /**
   * Analytics Engine bindings
   */
  analytics_engine_datasets?: Array<{
    /**
     * Binding name
     */
    binding: string;
    /**
     * Dataset name
     */
    dataset?: string;
  }>;

  /**
   * Route configuration
   */
  routes?: Array<string>;

  /**
   * Triggers configuration
   */
  triggers?: {
    /**
     * Cron triggers
     */
    crons: Array<string>;
  };

  /**
   * Worker compatibility date
   */
  compatibility_date?: string;

  /**
   * Worker compatibility flags
   */
  compatibility_flags?: Array<string>;

  /**
   * Worker usage model
   * "bundled" - Includes resources like CPU and memory. Better for consistent workloads.
   * "unbound" - Pay only for what you use. Better for sporadic workloads.
   */
  usage_model?: "bundled" | "unbound";

  /**
   * Path to the wrangler.json file
   * @internal
   */
  path?: string;
}

/**
 * Output returned after WranglerJson creation/update
 */
export interface WranglerJson
  extends Resource<"cloudflare::WranglerJson">,
    WranglerJsonProps {
  /**
   * Time at which the file was created
   */
  createdAt: number;

  /**
   * Time at which the file was last updated
   */
  updatedAt: number;
}

/**
 * Resource for managing wrangler.json configuration files
 */
export const WranglerJson = Resource(
  "cloudflare::WranglerJson",
  async function (
    this: Context<WranglerJson>,
    id: string,
    props: WranglerJsonProps,
  ): Promise<WranglerJson> {
    // Default path is wrangler.json in current directory
    const filePath = props.path || "wrangler.json";

    if (this.phase === "delete") {
      try {
        await fs.unlink(filePath);
      } catch (error) {
        // Ignore errors if file doesn't exist
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
      return this.destroy();
    }

    // Create or update the file
    const config = {
      ...props,
      // Remove internal path property
      path: undefined,
    };

    // Write the file
    await fs.writeFile(filePath, JSON.stringify(config, null, 2));

    // Return the resource
    return this({
      ...props,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  },
);
