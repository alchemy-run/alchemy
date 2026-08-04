import type {
  DurableObjectNamespace,
  HyperdriveOrigin,
  QueueConsumer,
  RuntimeWorker,
  Workflow,
} from "@distilled.cloud/cloudflare-runtime";
import type { WorkerBinding } from "./WorkerBinding.ts";
import type { WorkerAssetsConfig, WorkerSourceDescriptor } from "./Worker.ts";

/**
 * Default first port of the local dev-server range. Vite and
 * cloudflare-runtime advance to the next available port when it is taken,
 * unless `strictPort` is set.
 */
export const DEFAULT_DEV_PORT = 1337;

/** Plain-data configuration transferred from the provider to a Vite child. */
export interface ViteChildConfig {
  rootDir: string;
  publicUrl: string;
  accountId: string;
  storageDirectory: string;
  stack: { name: string; stage: string };
  env: Record<string, unknown>;
  source?: {
    descriptor: WorkerSourceDescriptor;
    id: string;
    assets: WorkerAssetsConfig | undefined;
  };
  worker: {
    name: string;
    compatibility: { date: string; flags: string[] };
    main: string | undefined;
    viteEnvironments: { entry?: string; children?: string[] } | undefined;
    hasAssets: boolean;
    bindingDescriptors: WorkerBinding[];
    /** Binding name → opt-out of local emulation (`Alchemy.remote()`). */
    devRemote: Record<string, boolean>;
    durableObjectNamespaces: (DurableObjectNamespace & {
      uniqueKey: string;
    })[];
    workflows: Workflow[];
    hyperdrives: Record<string, Required<HyperdriveOrigin>>;
    queueConsumers: QueueConsumer[];
    assets: RuntimeWorker["assets"];
  };
}

export const VITE_CHILD_READY_PREFIX = "<ALCHEMY_VITE_ADDRESS>";
export const VITE_CHILD_READY_SUFFIX = "</ALCHEMY_VITE_ADDRESS>";
