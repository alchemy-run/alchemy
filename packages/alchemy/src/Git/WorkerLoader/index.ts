/**
 * `alchemy/Git/WorkerLoader` — the pack hasher on dynamically loaded
 * Workers (DESIGN §22.12). A separate entry from `alchemy/Git`: its
 * `?worker` import bundles the hasher module at build time, which only
 * the Worker bundler understands.
 */
export {
  HasherWorkerLoader,
  LOADER_CHUNK_BYTES,
  LOADER_MAX_CONCURRENCY,
  type HasherWorkerLoaderOptions,
} from "./HasherWorkerLoader.ts";
