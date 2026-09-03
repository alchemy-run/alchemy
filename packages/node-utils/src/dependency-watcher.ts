import path from "node:path";
import { watch, type ChokidarOptions, type FSWatcher } from "chokidar";

export interface DependencyChange {
  readonly paths: ReadonlySet<string>;
}

export type DependencyChangeListener = (change: DependencyChange) => void;

export interface DependencyWatcherOptions {
  /** Chokidar options passed to the file watcher. */
  readonly watch?: ChokidarOptions | undefined;
  readonly debounceMs?: number | undefined;
}

/**
 * Watches an explicit set of absolute file paths and delivers debounced
 * change batches. Chokidar follows editor atomic-save replacements without
 * polling by default. The set is replaced wholesale with {@link set}, so the
 * watcher always mirrors exactly the files the caller currently depends on.
 */
export class DependencyWatcher {
  readonly #options: DependencyWatcherOptions;
  readonly #listeners = new Set<DependencyChangeListener>();
  readonly #watcher: FSWatcher;
  #dependencies: ReadonlySet<string> = new Set();
  #pending = new Set<string>();
  #timer: NodeJS.Timeout | undefined;
  #closed = false;

  constructor(options: DependencyWatcherOptions = {}) {
    this.#options = options;
    this.#watcher = watch([], {
      ...options.watch,
      ignoreInitial: true,
    });
    this.#watcher.on("all", (_event, changed) => {
      const absolute = path.resolve(this.#cwd(), changed);
      if (this.#dependencies.has(absolute)) this.#queue(absolute);
    });
  }

  get dependencies(): ReadonlySet<string> {
    return this.#dependencies;
  }

  subscribe(listener: DependencyChangeListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Replace the watched set with `dependencies` (absolute paths). */
  set(dependencies: ReadonlySet<string>): void {
    if (this.#closed) return;
    this.#dependencies = dependencies;
    const watched = new Set(
      Object.entries(this.#watcher.getWatched()).flatMap(([directory, files]) =>
        files.map((file) => path.resolve(this.#cwd(), directory, file)),
      ),
    );
    const removed = [...watched].filter(
      (dependency) => !dependencies.has(dependency),
    );
    const added = [...dependencies].filter(
      (dependency) => !watched.has(dependency),
    );
    if (removed.length > 0) void this.#watcher.unwatch(removed);
    if (added.length > 0) this.#watcher.add(added);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    await this.#watcher.close();
    this.#listeners.clear();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  #cwd(): string {
    return this.#options.watch?.cwd ?? process.cwd();
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
