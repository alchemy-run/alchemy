import { ResourceScope } from "../../resource.js";
import type { Scope } from "../../scope.js";
import { serialize } from "../../serde.js";
import { deserializeState, type State, type StateStore } from "../../state.js";
import { withExponentialBackoff } from "../../util/retry.js";
import { CloudflareApiError } from "../api-error.js";
import {
  type CloudflareApi,
  createCloudflareApi
} from "../api.js";
import { putWorker } from "../worker.js";
import { DOFS_WORKER_SCRIPT } from "./dofs-worker.js";

/**
 * Options for DOFSStateStore
 */
export interface DOFSStateStoreOptions {
  /**
   * The URL of the Durable Object Worker
   * If not provided, a worker will be auto-deployed
   */
  url?: string;

  /**
   * Optional authentication token for requests
   */
  token?: string;

  /**
   * Base path in the DOFS filesystem for storing state files
   */
  basePath?: string;

  /**
   * Auto-deploy the worker if it doesn't exist
   * @default true
   */
  autoDeploy?: boolean;

  /**
   * Name for the auto-deployed worker
   * @default "alchemy-dofs-state-store"
   */
  workerName?: string;

  /**
   * Whether to enable a workers.dev URL for the auto-deployed worker
   * @default true
   */
  workerUrl?: boolean;
}

/**
 * State store implementation using Cloudflare Durable Objects with DOFS (Durable Object File System)
 */
export class DOFSStateStore implements StateStore {
  private readonly basePath: string;
  private readonly fullPath: string;
  private api: CloudflareApi | null = null;
  private initialized = false;
  private readonly autoDeploy: boolean;
  private readonly workerName: string;
  private readonly workerUrl: boolean;
  private deployedWorkerUrl?: string;
  private isInitializing = false; // Add flag to prevent recursive initialization

  constructor(
    public readonly scope: Scope,
    private readonly options: DOFSStateStoreOptions,
  ) {
    // Create a hierarchical path based on scope chain
    this.basePath = options.basePath || "/alchemy";
    const scopePath = scope.chain.join("/");
    this.fullPath = `${this.basePath}/${scopePath}`;
    
    // Auto-deployment configuration
    this.autoDeploy = options.autoDeploy !== false; // Default to true
    this.workerName = options.workerName || "alchemy-dofs-state-store";
    this.workerUrl = options.workerUrl !== false; // Default to true
  }

  async init(): Promise<void> {
    if (this.initialized) {
      console.log("🔄 Already initialized, skipping...");
      return;
    }
    
    if (this.isInitializing) {
      console.log("⚠️  Init already in progress, waiting...");
      // Wait for the other initialization to complete
      while (this.isInitializing && !this.initialized) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return;
    }

    this.isInitializing = true;
    console.log("🚀 Starting DOFS state store initialization...");

    try {
      // If URL is provided, use it directly
      if (this.options.url) {
        console.log(`📍 Using provided worker URL: ${this.options.url}`);
        this.deployedWorkerUrl = this.options.url;
        this.initialized = true;
        console.log("✅ Initialization complete (using provided URL)");
        return;
      }

      // Auto-deploy worker if enabled and no URL provided
      if (this.autoDeploy) {
        try {
          console.log("🔧 Auto-deployment enabled, setting up API client...");
          
          // Create Cloudflare API client
          this.api = await createCloudflareApi();
          console.log(`✅ API client created for account: ${this.api.accountId}`);
          
          // Check if worker already exists
          console.log(`🔍 Checking if worker '${this.workerName}' already exists...`);
          const existingWorker = await this.checkWorkerExists();
          
          if (existingWorker) {
            console.log(`♻️  Found existing worker: ${existingWorker}`);
            this.deployedWorkerUrl = existingWorker;
          } else {
            console.log("🏗️  Worker not found, deploying new worker...");
            // Deploy the worker
            this.deployedWorkerUrl = await this.deployWorker();
          }
          
          // Mark as initialized BEFORE making directory creation request
          this.initialized = true;
          console.log("✅ Worker deployment complete, marked as initialized");
          
        } catch (error) {
          console.error("💥 Failed to auto-deploy DOFS state store worker:", error);
          throw new Error(`Failed to initialize DOFS state store: ${error}`);
        }
      } else {
        throw new Error("No worker URL provided and auto-deployment is disabled");
      }

      console.log("📁 Creating directory structure...");
      
      // Create the directory structure if it doesn't exist (now that we're marked as initialized)
      const directoryResponse = await this.fetchWithoutInit("", {
        method: "POST",
        headers: { "X-Operation": "mkdir" },
        body: JSON.stringify({ path: this.fullPath, recursive: true }),
      });
      
      if (directoryResponse.ok) {
        console.log("✅ Directory structure created successfully");
      } else {
        console.log(`⚠️  Directory creation returned ${directoryResponse.status}: ${directoryResponse.statusText}`);
      }

      console.log("🎉 DOFS state store initialization complete!");
    } finally {
      this.isInitializing = false;
    }
  }

  /**
   * Check if the worker already exists and return its URL
   */
  private async checkWorkerExists(): Promise<string | null> {
    if (!this.api) return null;

    try {
      const response = await this.api.get(
        `/accounts/${this.api.accountId}/workers/scripts/${this.workerName}`,
      );
      
      if (response.status === 404) {
        return null; // Worker doesn't exist
      }
      
      if (response.status === 200) {
        // Worker exists, get its URL
        if (this.workerUrl) {
          const subdomainResponse = await this.api.get(
            `/accounts/${this.api.accountId}/workers/subdomain`,
          );
          
          if (subdomainResponse.ok) {
            const subdomainData: any = await subdomainResponse.json();
            const subdomain = subdomainData.result?.subdomain;
            
            if (subdomain) {
              return `https://${this.workerName}.${subdomain}.workers.dev`;
            }
          }
        }
        
        // Fallback to account subdomain format
        return `https://${this.workerName}.${this.api.accountId}.workers.dev`;
      }
      
      throw new Error(`Unexpected response when checking worker: ${response.status}`);
    } catch (error) {
      console.error("Error checking if worker exists:", error);
      return null;
    }
  }

  /**
   * Deploy the DOFS state store worker
   */
  private async deployWorker(): Promise<string> {
    if (!this.api) {
      throw new Error("API client not initialized");
    }

    try {
      // Create worker metadata with DOFS durable object binding
      const metadata = {
        compatibility_date: "2023-12-01",
        compatibility_flags: [],
        bindings: [
          {
            type: "durable_object_namespace" as const,
            name: "ALCHEMY_DOFS_STATE_STORE",
            class_name: "AlchemyDOFSStateStore",
            script_name: this.workerName,
          },
        ],
        observability: {
          enabled: true,
        },
        main_module: "index.js",
        migrations: {
          new_classes: ["AlchemyDOFSStateStore"],
          deleted_classes: [],
          renamed_classes: [],
          transferred_classes: [],
          new_sqlite_classes: [],
        },
      };

      // Deploy the worker
      await withExponentialBackoff(
        () => putWorker(this.api!, this.workerName, DOFS_WORKER_SCRIPT, metadata),
        (error) => isRetryableError(error),
        5,
        1000,
      );

      // Enable workers.dev URL if requested
      let workerUrl: string;
      if (this.workerUrl) {
        await this.api.post(
          `/accounts/${this.api.accountId}/workers/scripts/${this.workerName}/subdomain`,
          { enabled: true, previews_enabled: true },
          {
            headers: { "Content-Type": "application/json" },
          },
        );

        const subdomainResponse = await this.api.get(
          `/accounts/${this.api.accountId}/workers/subdomain`,
        );

        if (subdomainResponse.ok) {
          const subdomainData: any = await subdomainResponse.json();
          const subdomain = subdomainData.result?.subdomain;
          
          if (subdomain) {
            workerUrl = `https://${this.workerName}.${subdomain}.workers.dev`;
            
            // Add delay to prevent negative cache hits
            await new Promise((resolve) => setTimeout(resolve, 3000));
          } else {
            workerUrl = `https://${this.workerName}.${this.api.accountId}.workers.dev`;
          }
        } else {
          workerUrl = `https://${this.workerName}.${this.api.accountId}.workers.dev`;
        }
      } else {
        workerUrl = `https://${this.workerName}.${this.api.accountId}.workers.dev`;
      }

      console.log(`✅ Auto-deployed DOFS state store worker: ${workerUrl}`);
      return workerUrl;
    } catch (error) {
      console.error("Failed to deploy worker:", error);
      throw error;
    }
  }

  async deinit(): Promise<void> {
    // Optionally clean up the directory
    try {
      await this.fetch("", {
        method: "DELETE",
        headers: { "X-Operation": "rmdir" },
        body: JSON.stringify({ path: this.fullPath, recursive: true }),
      });
    } catch (error) {
      // Ignore cleanup errors
    }
  }

  async list(): Promise<string[]> {
    try {
      const response = await this.fetch("", {
        method: "GET",
        headers: { 
          "X-Operation": "listDir",
          "X-Path": this.fullPath
        },
      });
      
      if (!response.ok) {
        if (response.status === 404) {
          return [];
        }
        throw new Error(`Failed to list: ${response.statusText}`);
      }
      
      const files: string[] = await response.json();
      
      // Filter out non-json files and convert filenames back to keys
      return files
        .filter((file) => file.endsWith(".json") && file !== "." && file !== "..")
        .map((file) => file.replace(/\.json$/, ""))
        .map((key) => this.deserializeKey(key));
    } catch (error: any) {
      if (error.message?.includes("ENOENT")) {
        return [];
      }
      throw error;
    }
  }

  async count(): Promise<number> {
    return (await this.list()).length;
  }

  async get(key: string): Promise<State | undefined> {
    try {
      const filePath = this.getFilePath(key);
      const response = await this.fetch("", {
        method: "GET",
        headers: { 
          "X-Operation": "readFile",
          "X-Path": filePath
        },
      });

      if (!response.ok) {
        if (response.status === 404) {
          return undefined;
        }
        throw new Error(`Failed to get state: ${response.statusText}`);
      }

      const content = await response.text();
      const state = await deserializeState(this.scope, content);
      
      // Ensure output has the scope set
      if (state.output === undefined) {
        state.output = {} as any;
      }
      state.output[ResourceScope] = this.scope;
      
      return state;
    } catch (error: any) {
      if (error.message?.includes("ENOENT")) {
        return undefined;
      }
      throw error;
    }
  }

  async set(key: string, value: State): Promise<void> {
    // Ensure directory exists
    await this.init();
    
    const filePath = this.getFilePath(key);
    const serializedData = JSON.stringify(await serialize(this.scope, value), null, 2);
    
    const response = await this.fetch("", {
      method: "PUT",
      headers: { "X-Operation": "writeFile" },
      body: JSON.stringify({ 
        path: filePath,
        data: serializedData 
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to set state: ${response.statusText}`);
    }
  }

  async delete(key: string): Promise<void> {
    try {
      const filePath = this.getFilePath(key);
      const response = await this.fetch("", {
        method: "DELETE",
        headers: { "X-Operation": "unlink" },
        body: JSON.stringify({ path: filePath }),
      });

      // Ignore 404 errors - file already doesn't exist
      if (!response.ok && response.status !== 404) {
        throw new Error(`Failed to delete state: ${response.statusText}`);
      }
    } catch (error: any) {
      if (error.message?.includes("ENOENT")) {
        return; // File already doesn't exist
      }
      throw error;
    }
  }

  async all(): Promise<Record<string, State>> {
    return this.getBatch(await this.list());
  }

  async getBatch(ids: string[]): Promise<Record<string, State>> {
    const results = await Promise.all(
      ids.map(async (id) => {
        const state = await this.get(id);
        return state ? [id, state] as const : undefined;
      })
    );

    return Object.fromEntries(
      results.filter((result): result is [string, State] => result !== undefined)
    );
  }

  private async fetch(url: string, init?: RequestInit): Promise<Response> {
    // Ensure initialized before making requests
    await this.ensureInitialized();
    
    return this.fetchWithoutInit(url, init);
  }

  /**
   * Make a fetch request without ensuring initialization (used during init to prevent infinite loop)
   */
  private async fetchWithoutInit(url: string, init?: RequestInit): Promise<Response> {
    const baseUrl = this.deployedWorkerUrl || this.options.url;
    if (!baseUrl) {
      throw new Error("No worker URL available - initialization may have failed");
    }

    const fullUrl = `${baseUrl}${url}`;
    const operation = (init?.headers as Record<string, string>)?.["X-Operation"] || "unknown";
    
    console.log(`🔗 Making request to worker: ${operation} -> ${fullUrl}`);
    
    const maxRetries = 10;
    let retries = 0;
    let delay = 30;
    let response: Response;

    while (retries < maxRetries) {
      const startTime = Date.now();
      
      try {
        console.log(`   📡 Attempt ${retries + 1}/${maxRetries}: ${operation}`);
        
        response = await fetch(fullUrl, {
          ...init,
          headers: {
            "Content-Type": "application/json",
            ...(this.options.token && { Authorization: `Bearer ${this.options.token}` }),
            ...init?.headers,
          },
        });

        const duration = Date.now() - startTime;
        console.log(`   ⚡ Response received in ${duration}ms: ${response.status} ${response.statusText}`);

        if (response.ok) {
          console.log(`   ✅ Success: ${operation}`);
          return response;
        }

        console.log(`   ❌ Error response: ${response.status} ${response.statusText}`);
        
        // Log response body for debugging
        try {
          const responseText = await response.clone().text();
          console.log(`   📄 Response body: ${responseText.substring(0, 200)}${responseText.length > 200 ? '...' : ''}`);
        } catch (e) {
          console.log(`   📄 Could not read response body: ${e}`);
        }

        // Retry on rate limits and server errors
        if (
          response.status === 429 ||
          response.status === 500 ||
          response.status === 503
        ) {
          console.log(`   🔄 Retryable error, waiting ${delay}ms before retry...`);
          delay *= 2;
          retries += 1;
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        // Don't retry other errors
        console.log(`   🚫 Non-retryable error, returning response`);
        return response;
        
      } catch (fetchError) {
        const duration = Date.now() - startTime;
        console.log(`   💥 Fetch error after ${duration}ms:`, fetchError);
        
        retries += 1;
        if (retries >= maxRetries) {
          throw new Error(`Network error after ${maxRetries} retries: ${fetchError}`);
        }
        
        console.log(`   🔄 Network error, waiting ${delay}ms before retry...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2;
      }
    }

    throw new Error(`Failed to fetch after ${maxRetries} retries: ${response!.statusText}`);
  }

  private getFilePath(key: string): string {
    return `${this.fullPath}/${this.serializeKey(key)}.json`;
  }

  private serializeKey(key: string): string {
    // Replace problematic characters for filesystem
    return key.replaceAll("/", ":");
  }

  private deserializeKey(key: string): string {
    // Convert back from filesystem-safe format
    return key.replaceAll(":", "/");
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.init();
    }
  }
}

/**
 * Check if an error is retryable
 */
function isRetryableError(error: any): boolean {
  if (error instanceof CloudflareApiError) {
    return (
      error.status === 500 ||
      error.status === 502 ||
      error.status === 503 ||
      error.message.includes("timeout") ||
      error.message.includes("internal error")
    );
  }
  return false;
} 