import type { Scope } from "../../scope.js";
import { serialize } from "../../serde.js";
import { deserializeState, type State, type StateStore } from "../../state.js";
import { ResourceScope } from "../../resource.js";

/**
 * Options for DOFSStateStore
 */
export interface DOFSStateStoreOptions {
  /**
   * The URL of the Durable Object Worker
   */
  url: string;

  /**
   * Optional authentication token for requests
   */
  token?: string;

  /**
   * Base path in the DOFS filesystem for storing state files
   */
  basePath?: string;
}

/**
 * State store implementation using Cloudflare Durable Objects with DOFS (Durable Object File System)
 */
export class DOFSStateStore implements StateStore {
  private readonly basePath: string;

  constructor(
    public readonly scope: Scope,
    private readonly options: DOFSStateStoreOptions,
  ) {
    // Create a hierarchical path based on scope chain
    this.basePath = options.basePath || "/alchemy";
    const scopePath = scope.chain.join("/");
    this.fullPath = `${this.basePath}/${scopePath}`;
  }

  private readonly fullPath: string;

  async init(): Promise<void> {
    // Create the directory structure if it doesn't exist
    await this.fetch("", {
      method: "POST",
      headers: { "X-Operation": "mkdir" },
      body: JSON.stringify({ path: this.fullPath, recursive: true }),
    });
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
        headers: { "X-Operation": "listDir" },
        body: JSON.stringify({ path: this.fullPath }),
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
        headers: { "X-Operation": "readFile" },
        body: JSON.stringify({ path: filePath }),
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
    const maxRetries = 10;
    let retries = 0;
    let delay = 30;
    let response: Response;

    while (retries < maxRetries) {
      response = await fetch(`${this.options.url}${url}`, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          ...(this.options.token && { Authorization: `Bearer ${this.options.token}` }),
          ...init?.headers,
        },
      });

      if (response.ok) {
        return response;
      }

      // Retry on rate limits and server errors
      if (
        response.status === 429 ||
        response.status === 500 ||
        response.status === 503
      ) {
        delay *= 2;
        retries += 1;
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      // Don't retry other errors
      return response;
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
} 