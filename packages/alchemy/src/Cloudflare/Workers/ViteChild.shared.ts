import type {
  DurableObjectNamespace,
  HyperdriveOrigin,
  QueueConsumer,
  RuntimeWorker,
  Workflow,
} from "@alchemy.run/cloudflare-runtime/core";
import { fileURLToPath } from "node:url";
import nodePath from "node:path";
import type { BundleOutput } from "../../Bundle/Bundle.ts";
import { isWorkflowExport } from "../Workflows/Workflow.ts";
import { isDurableObjectExport } from "./DurableObject.ts";
import type { WorkerBinding } from "./WorkerBinding.ts";
import {
  DEFAULT_SERVER_ROUTES,
  type WorkerAssetsConfig,
  type WorkerProps,
  type WorkerSourceDescriptor,
} from "./Worker.ts";

/**
 * Default first port of the local dev-server range. Vite and
 * cloudflare-runtime advance to the next available port when it is taken,
 * unless `strictPort` is set.
 */
export const DEFAULT_DEV_PORT = 1337;

/**
 * Plain-data description of collect-only *wrapper* delivery for a vite-built
 * Worker (an effectful Website: impl + `runtimeDelivery: "wrapper"`). This is
 * everything the generated `virtual:alchemy:website-entry` module needs, kept
 * V8-serializable so it can cross the engine → vite-child process boundary
 * (see `ViteBuildChildConfig` / `ViteChildConfig`): module *paths* and class
 * *names* only — never Effects or closures.
 */
export interface ViteEffectEntry {
  /**
   * Absolute filesystem path of the user's site module (the impl anchor,
   * `main: import.meta.url` converted from a `file://` URL). The generated
   * wrapper re-imports the Website class from here inside workerd.
   */
  readonly mainPath: string;
  /**
   * Absolute filesystem path of the USER's worker entry (`server.entry`,
   * the mount file) — when present the wrapper grafts its `fetch` verbatim
   * and `routes` is not applied (the entry's mount decides routing).
   */
  readonly entryPath?: string | undefined;
  /** Path globs the Effect fetch owns (`server.routes`, default `/api/*`). */
  readonly routes: string[];
  /**
   * DO/Workflow class exports (`props.exports`), reduced to plain names —
   * the full export records carry Effects that cannot cross the child
   * boundary and are not needed for codegen.
   */
  readonly exports: {
    readonly name: string;
    readonly kind: "durableObject" | "workflow";
  }[];
}

/**
 * Derive the {@link ViteEffectEntry} from resolved Worker props, or
 * `undefined` when the Worker is not wrapper-delivery (plain vite sites,
 * explicit-tier `runtimeDelivery: "external"`). Pure and cheap — safe inside
 * the local provider's `resolveConfig` (runs on every plan) where its result
 * participates in the restart-surface hash, so route/anchor edits restart
 * the dev child.
 */
export const makeViteEffectEntry = (
  props: Pick<WorkerProps, "main" | "server" | "exports" | "runtimeDelivery">,
): ViteEffectEntry | undefined => {
  if (props.runtimeDelivery !== "wrapper" || props.main === undefined) {
    return undefined;
  }
  let mainPath: string;
  try {
    mainPath = fileURLToPath(props.main);
  } catch {
    mainPath = props.main;
  }
  mainPath = nodePath.resolve(mainPath);
  const entry = props.server?.entry;
  let entryPath: string | undefined;
  if (entry !== undefined) {
    let p: string;
    try {
      p = fileURLToPath(entry);
    } catch {
      p = entry;
    }
    // Relative entries anchor to the backend module's directory, so the
    // pair travels together (`main: import.meta.url`, `entry: "./server.ts"`).
    entryPath = nodePath.isAbsolute(p)
      ? p
      : nodePath.resolve(nodePath.dirname(mainPath), p);
  }
  return {
    mainPath,
    entryPath,
    routes: props.server?.routes ?? [...DEFAULT_SERVER_ROUTES],
    exports: Object.entries(props.exports ?? {}).flatMap(
      ([name, entry]): ViteEffectEntry["exports"] =>
        isDurableObjectExport(entry)
          ? [{ name, kind: "durableObject" }]
          : isWorkflowExport(entry)
            ? [{ name, kind: "workflow" }]
            : [],
    ),
  };
};

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
    /** Wrapper-delivery effect entry (effectful Website); plain data. */
    entry?: ViteEffectEntry | undefined;
    viteEnvironments: { entry?: string; children?: string[] } | undefined;
    hasAssets: boolean;
    bindingDescriptors: WorkerBinding[];
    /** Binding name → opt-out of local emulation (`Alchemy.remote()`). */
    devRemote: Record<string, boolean>;
    /** Simulated Cloudflare Access config (`dev: { access: ... }`). */
    devAccess?: { aud?: string; identity?: Record<string, unknown> };
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

/**
 * Plain-data configuration transferred from the provider to a one-shot
 * Vite *build* child (`ViteBuildChildRunner.ts`). Deliberately much
 * smaller than {@link ViteChildConfig}: a production build needs no
 * workerd runtime, credentials, or binding materialization.
 */
export interface ViteBuildChildConfig {
  /** Absolute project root; also the child process's working directory. */
  rootDir: string;
  /**
   * `VITE_`-prefixed env entries — the only ones the build consumes
   * (inlined as `import.meta.env.*` defines).
   */
  env: Record<string, unknown>;
  main: string | undefined;
  /** Wrapper-delivery effect entry (effectful Website); plain data. */
  entry?: ViteEffectEntry | undefined;
  compatibilityDate: string | undefined;
  compatibilityFlags: string[] | undefined;
  viteEnvironments: { entry?: string; children?: string[] } | undefined;
  /** Absolute path the child writes the V8-serialized result to. */
  outputPath: string;
}

/** Result the build child writes to `outputPath` (V8-serialized). */
export interface ViteBuildChildResult {
  clientDirectory: string | undefined;
  base: string | undefined;
  serverBundle: BundleOutput | undefined;
  externalWorkspaces: string[];
}
