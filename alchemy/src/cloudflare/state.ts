import type { KVNamespace } from "@cloudflare/workers-types";
import type { State, StateStore } from "../state";

/**
 * Options for CloudflareStateStore
 */
export interface CloudflareStateStoreOptions {
  /**
   * The prefix to use for keys in the KV namespace
   * This allows multiple state stores to use the same KV namespace
   */
  prefix?: string;
}

/**
 * State store implementation using Cloudflare KV Namespace
 */
export class CloudflareStateStore implements StateStore {
  private namespace: KVNamespace;
  private prefix: string;

  /**
   * Create a new CloudflareStateStore
   *
   * @param namespace The KV namespace to use for storing state
   * @param options Options for the state store
   */
  constructor(
    namespace: KVNamespace,
    options: CloudflareStateStoreOptions = {},
  ) {
    this.namespace = namespace;
    this.prefix = options.prefix || "alchemy-state:";
  }

  /**
   * No initialization needed for KV namespaces as they are pre-provisioned
   */
  async init(): Promise<void> {
    // KV namespaces are pre-provisioned in Cloudflare, so no initialization is needed
  }

  /**
   * KV namespaces cannot be deleted programmatically
   */
  async deinit(): Promise<void> {
    // KV namespaces can only be deleted through the Cloudflare dashboard or API
    // We cannot delete the namespace itself here
  }

  /**
   * List all resources in the state store
   */
  async list(): Promise<string[]> {
    const list = await this.namespace.list({ prefix: this.prefix });
    return list.keys.map((key) => key.name.slice(this.prefix.length));
  }

  /**
   * Count the number of items in the state store
   */
  async count(): Promise<number> {
    const list = await this.namespace.list({ prefix: this.prefix });
    return list.keys.length;
  }

  /**
   * Get a state by key
   *
   * @param key The key to look up
   * @returns The state or undefined if not found
   */
  async get(key: string): Promise<State | undefined> {
    const data = await this.namespace.get(this.getNamespacedKey(key), "json");
    return data as State | undefined;
  }

  /**
   * Get multiple states by their keys
   *
   * @param ids Array of keys to fetch
   * @returns Record mapping keys to their states
   */
  async getBatch(ids: string[]): Promise<Record<string, State>> {
    const result: Record<string, State> = {};

    // KV doesn't have a native batch get operation, so we need to make multiple requests
    // We could optimize this with Promise.all for parallel fetching
    const promises = ids.map(async (id) => {
      const state = await this.get(id);
      if (state) {
        result[id] = state;
      }
    });

    await Promise.all(promises);
    return result;
  }

  /**
   * Get all states in the store
   *
   * @returns Record mapping all keys to their states
   */
  async all(): Promise<Record<string, State>> {
    const keys = await this.list();
    return this.getBatch(keys);
  }

  /**
   * Set a state for a key
   *
   * @param key The key to set
   * @param value The state to store
   */
  async set(key: string, value: State): Promise<void> {
    await this.namespace.put(this.getNamespacedKey(key), JSON.stringify(value));
  }

  /**
   * Delete a state by key
   *
   * @param key The key to delete
   */
  async delete(key: string): Promise<void> {
    await this.namespace.delete(this.getNamespacedKey(key));
  }

  /**
   * Get the namespaced key for storage
   *
   * @param key The original key
   * @returns The key with prefix for use in the KV namespace
   */
  private getNamespacedKey(key: string): string {
    return `${this.prefix}${key}`;
  }
}
