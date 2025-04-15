import type { Context } from "../context";
import { StaticJsonFile } from "../fs";
import { Resource } from "../resource";
import type { Bindings } from "./bindings";
import type { DurableObjectNamespace } from "./durable-object-namespace";
import type { Worker } from "./worker";

/**
 * Properties for wrangler.json configuration file
 */
export interface WranglerJsonProps {
  name?: string;
  /**
   * The worker to generate the wrangler.json file for
   */
  worker: Worker;
  /**
   * Path to write the wrangler.json file to
   *
   * @default cwd/wrangler.json
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

  /**
   * Path to the wrangler.json file
   */
  path: string;
}

/**
 * Resource for managing wrangler.json configuration files
 */
export const WranglerJson = Resource(
  "cloudflare::WranglerJson",
  async function (
    this: Context<WranglerJson>,
    id: string,
    props: WranglerJsonProps
  ): Promise<WranglerJson> {
    // Default path is wrangler.json in current directory
    const filePath = props.path || "wrangler.json";

    if (this.phase === "delete") {
      return this.destroy();
    }

    if (props.worker.entrypoint === undefined) {
      throw new Error(
        "Worker must have an entrypoint to generate a wrangler.json"
      );
    }

    const worker = props.worker;

    const spec: WranglerJsonSpec = {
      name: worker.name,
      // Use entrypoint as main if it exists
      main: worker.entrypoint,
      // see: https://developers.cloudflare.com/workers/configuration/compatibility-dates/
      compatibility_date: "2022-04-05",
    };

    // Process bindings if they exist
    if (worker.bindings) {
      processBindings(spec, worker.bindings);
    }

    // Add environment variables as vars
    if (worker.env) {
      spec.vars = { ...worker.env };
    }

    await StaticJsonFile("wrangler.json", spec);

    // Return the resource
    return this({
      ...props,
      path: filePath,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }
);

/**
 * Wrangler.json configuration specification based on Cloudflare's schema
 */
export interface WranglerJsonSpec {
  /**
   * The name of the worker
   */
  name: string;

  /**
   * Main entry point for the worker
   */
  main?: string;

  /**
   * A date in the form yyyy-mm-dd used to determine Workers runtime version
   */
  compatibility_date?: string;

  /**
   * A list of flags that enable features from upcoming Workers runtime
   */
  compatibility_flags?: string[];

  /**
   * Whether to enable a workers.dev URL for this worker
   */
  workers_dev?: boolean;

  /**
   * Routes to attach to the worker
   */
  routes?: string[];

  /**
   * KV Namespace bindings
   */
  kv_namespaces?: {
    binding: string;
    id: string;
  }[];

  /**
   * Durable Object bindings
   */
  durable_objects?: {
    bindings: {
      name: string;
      class_name: string;
      script_name?: string;
      environment?: string;
    }[];
  };

  /**
   * R2 bucket bindings
   */
  r2_buckets?: {
    binding: string;
    bucket_name: string;
  }[];

  /**
   * Service bindings
   */
  services?: {
    binding: string;
    service: string;
    environment?: string;
  }[];

  /**
   * Workflow bindings
   */
  workflows?: {
    name: string;
    binding: string;
    class_name: string;
  }[];

  /**
   * Plain text bindings (vars)
   */
  vars?: Record<string, string>;

  /**
   * Assets bindings
   */
  assets?: {
    directory: string;
    binding: string;
  };

  /**
   * Workflow bindings
   */
  wasm_modules?: Record<string, string>;

  /**
   * Safe mode configuration
   */
  node_compat?: boolean;

  /**
   * Whether to minify the worker script
   */
  minify?: boolean;
}

/**
 * Process worker bindings into wrangler.json format
 */
function processBindings(spec: WranglerJsonSpec, bindings: Bindings): void {
  // Arrays to collect different binding types
  const kvNamespaces: { binding: string; id: string }[] = [];
  const durableObjects: {
    name: string;
    class_name: string;
    script_name?: string;
    environment?: string;
  }[] = [];
  const r2Buckets: { binding: string; bucket_name: string }[] = [];
  const services: { binding: string; service: string; environment?: string }[] =
    [];
  const secrets: string[] = [];
  const workflows: { name: string; binding: string; class_name: string }[] = [];
  const d1Databases: {
    binding: string;
    database_id: string;
    database_name: string;
  }[] = [];

  // Process each binding
  for (const [bindingName, binding] of Object.entries(bindings)) {
    if (typeof binding === "string") {
      // Plain text binding - add to vars
      if (!spec.vars) {
        spec.vars = {};
      }
      spec.vars[bindingName] = binding;
    } else if (binding.type === "kv_namespace") {
      // KV Namespace binding
      kvNamespaces.push({
        binding: bindingName,
        id: binding.namespaceId,
      });
    } else if (
      typeof binding === "object" &&
      binding.type === "durable_object_namespace"
    ) {
      // Durable Object binding
      const doBinding = binding as DurableObjectNamespace;
      durableObjects.push({
        name: bindingName,
        class_name: doBinding.className,
        script_name: doBinding.scriptName,
        environment: doBinding.environment,
      });
    } else if (binding.type === "r2_bucket") {
      r2Buckets.push({
        binding: bindingName,
        bucket_name: binding.name,
      });
    } else if (binding.type === "service") {
      // Service binding
      services.push({
        binding: bindingName,
        service: binding.id,
      });
    } else if (binding.type === "secret") {
      // Secret binding
      secrets.push(bindingName);
    } else if (typeof binding === "string") {
      // Plain text binding - add to vars
      if (!spec.vars) {
        spec.vars = {};
      }
      spec.vars[bindingName] = binding;
    } else if (binding.type === "assets") {
      spec.assets = {
        directory: binding.path,
        binding: bindingName,
      };
    } else if (binding.type === "workflow") {
      workflows.push({
        name: bindingName,
        binding: binding.id,
        class_name: binding.className,
      });
    } else if (binding.type === "d1") {
      d1Databases.push({
        binding: bindingName,
        database_id: binding.id,
        database_name: binding.name,
      });
    }
  }

  // Add collected bindings to the spec
  if (kvNamespaces.length > 0) {
    spec.kv_namespaces = kvNamespaces;
  }

  if (durableObjects.length > 0) {
    spec.durable_objects = {
      bindings: durableObjects,
    };
  }

  if (r2Buckets.length > 0) {
    spec.r2_buckets = r2Buckets;
  }

  if (services.length > 0) {
    spec.services = services;
  }
}
