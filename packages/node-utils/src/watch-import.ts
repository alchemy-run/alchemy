import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { watch, type ChokidarOptions, type FSWatcher } from "chokidar";
import {
  createImportLoader,
  type ImportLoader,
  type ImportLoaderOptions,
} from "./import-loader.ts";

export interface ImportGeneration<T> {
  readonly value: T;
  readonly namespace: string;
  readonly dependencies: ReadonlySet<string>;
}

export interface ImportChange {
  readonly paths: ReadonlySet<string>;
}

export interface ImportWatcherOptions extends ImportLoaderOptions {
  readonly parentURL: string;
  /** Chokidar options passed to the dependency watcher. */
  readonly watch?: ChokidarOptions | undefined;
  readonly debounceMs?: number | undefined;
}

export type ImportChangeListener = (change: ImportChange) => void;

/**
 * Imports fresh Node module generations and watches the exact files loaded by
 * the current generation. Chokidar follows editor atomic-save replacements
 * without polling by default. Bun callers should use Bun's process watcher,
 * which naturally starts each generation with a fresh module cache.
 */
export class ImportWatcher<T = unknown> {
  readonly #specifier: string;
  readonly #options: ImportWatcherOptions;
  readonly #listeners = new Set<ImportChangeListener>();
  readonly #watcher: FSWatcher;
  #registration: ImportLoader | undefined;
  #dependencies = new Set<string>();
  #pending = new Set<string>();
  #timer: NodeJS.Timeout | undefined;
  #closed = false;

  constructor(specifier: string, options: ImportWatcherOptions) {
    this.#specifier = specifier;
    this.#options = options;
    this.#watcher = watch([], {
      ...options.watch,
      ignoreInitial: true,
    });
    this.#watcher.on("all", (_event, changed) => {
      const absolute = path.resolve(
        options.watch?.cwd ?? process.cwd(),
        changed,
      );
      if (this.#dependencies.has(absolute)) this.#queue(absolute);
    });
  }

  get dependencies(): ReadonlySet<string> {
    return this.#dependencies;
  }

  subscribe(listener: ImportChangeListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async import(): Promise<ImportGeneration<T>> {
    if (this.#closed) throw new Error("ImportWatcher is closed");
    const namespace = randomUUID();
    const dependencies = new Set<string>();
    const {
      debounceMs: _,
      parentURL,
      watch: _watch,
      ...registerOptions
    } = this.#options;
    const registration = await createImportLoader({
      ...registerOptions,
      namespace,
      onImport: (url) => {
        if (!url.startsWith("file:")) return;
        dependencies.add(fileURLToPath(url));
        if (this.#dependencies === dependencies) this.#syncWatchers();
      },
    });
    try {
      const value = await registration.import<T>(this.#specifier, parentURL);
      await this.#registration?.unregister();
      this.#registration = registration;
      this.#dependencies = dependencies;
      this.#syncWatchers();
      return { value, namespace, dependencies };
    } catch (error) {
      await registration.unregister();
      this.#dependencies = new Set([...this.#dependencies, ...dependencies]);
      this.#syncWatchers();
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    await this.#registration?.unregister();
    await this.#watcher.close();
    this.#listeners.clear();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  #syncWatchers(): void {
    const previous = this.#watcher.getWatched();
    const watched = new Set(
      Object.entries(previous).flatMap(([directory, files]) =>
        files.map((file) =>
          path.resolve(
            this.#options.watch?.cwd ?? process.cwd(),
            directory,
            file,
          ),
        ),
      ),
    );
    const removed = [...watched].filter(
      (dependency) => !this.#dependencies.has(dependency),
    );
    const added = [...this.#dependencies].filter(
      (dependency) => !watched.has(dependency),
    );
    if (removed.length > 0) void this.#watcher.unwatch(removed);
    if (added.length > 0) this.#watcher.add(added);
  }

  #queue(changed: string): void {
    this.#pending.add(changed);
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      const paths = this.#pending;
      this.#pending = new Set();
      for (const listener of this.#listeners) listener({ paths });
    }, this.#options.debounceMs ?? 50);
  }
}

export const watchImport = <T = unknown>(
  specifier: string,
  options: ImportWatcherOptions,
) => new ImportWatcher<T>(specifier, options);
