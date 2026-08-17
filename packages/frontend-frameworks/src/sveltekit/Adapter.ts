// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
/**
 * In-memory SvelteKit `Adapter` — a wrangler-free fork of
 * `@sveltejs/adapter-cloudflare`'s `adapt()`.
 *
 * Differences from upstream:
 *
 * - No `unstable_readConfig` / wrangler.json: always Workers mode with plain
 *   options (`dest` fixed to kit's `cloudflare` build directory, assets
 *   binding defaults to `ASSETS`).
 * - No Pages mode, no `_routes.json`.
 * - The worker shim is generated directly with real relative import paths
 *   (see `WorkerShim.ts`); upstream ships a prebuilt `files/worker.js` and
 *   string-replaces `SERVER`/`MANIFEST` placeholders.
 * - `emulate()` supplies the dev `platform` from `cloudflare-runtime`'s
 *   platform proxy (`getPlatformProxy`) instead of wrangler's: real bindings
 *   round-trip through a workerd instance, `caches` actually stores/matches
 *   (wrangler's is a no-op), `cf`/`ctx` mocks match wrangler's.
 *
 * The adapter does **not** bundle the app: `adapt()` records the assets
 * directory and the unbundled worker entry on `result`, and the `SvelteKit`
 * Framework service runs the rolldown pass afterwards (replacing the bundling
 * `wrangler deploy` performs for the upstream adapter).
 *
 * Note: this module runs as a SvelteKit build callback (kit calls `adapt()`
 * inside Vite's `buildApp`), so it uses kit's synchronous `Builder` API and
 * `node:fs` directly like upstream — it is framework-callback code, not an
 * Effect service.
 */
import type { BindingHooks } from "@alchemy.run/cloudflare-runtime/core";
import type { Adapter, Builder, Emulator } from "@sveltejs/kit";
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import { pathToFileURL } from "node:url";

// Re-exported for callers that historically imported the scan from the
// adapter module (it moved to the cloud-agnostic `EffectDev.ts` so the AWS
// target can share it without importing this Cloudflare-specific module).
export { scanForExplicitServeMount } from "./EffectDev.ts";
import {
  generateWorkerShim,
  type WorkerShimEffectOptions,
} from "./WorkerShim.ts";

/**
 * How the adapter resolved effectful (wrapper) delivery for this build —
 * consumed by the Cloudflare target's finishing pass to widen the bundle's
 * `exports` list and enable the runtime define/minification.
 */
export interface CloudflareAdapterEffectResult {
  /**
   * `true` when the worker shim was generated WITH the effect arm. `false`
   * when an explicit `alchemy/Serve` mount was detected in kit's built
   * server graph and the wrapper generator stood down (DESIGN §6.3 — the
   * explicit mount wins; no double bridging).
   */
  readonly active: boolean;
  /** DO/Workflow bridge class names the shim re-exports (active only). */
  readonly exportNames: ReadonlyArray<string>;
}

export interface CloudflareAdapterResult {
  /**
   * The static-assets directory (client build + prerendered pages +
   * `_headers`/`_redirects`/`.assetsignore`) — upload wholesale as the
   * Worker's assets directory; becomes `BuildOutput.clientDirectory`.
   */
  readonly dest: string;
  /** The generated (unbundled) worker entry — input for the rolldown pass. */
  readonly workerEntry: string;
  /** Present iff the adapter was constructed with `effect` options. */
  readonly effect?: CloudflareAdapterEffectResult | undefined;
}

export interface CloudflareAdapterOptions {
  /**
   * Name of the static-assets binding the worker shim serves files through.
   * @default "ASSETS"
   */
  readonly assetsBinding?: string | undefined;
  /**
   * Mirror of Workers static assets `not_found_handling`, driving fallback
   * page generation: `"404-page"` writes `404.html`,
   * `"single-page-application"` writes `index.html` AND makes the worker
   * shim defer router-level not-founds on navigation-shaped requests to the
   * assets layer so the fallback governs (see `WorkerShim.ts`).
   * @default "none"
   */
  readonly notFoundHandling?:
    | "none"
    | "404-page"
    | "single-page-application"
    | undefined;
  /**
   * With `notFoundHandling: "404-page"`: `"spa"` renders the app shell as the
   * fallback, `"plaintext"` writes a plain `Not Found` page.
   * @default "plaintext"
   */
  readonly fallback?: "spa" | "plaintext" | undefined;
  /**
   * Project root used to locate user-authored `_headers` / `_redirects`
   * files.
   * @default process.cwd()
   */
  readonly root?: string | undefined;
  /**
   * Inputs for the dev platform returned from `emulate()` (see
   * {@link CloudflareDevPlatformOptions}). When present, `emulate()` serves
   * `platform = { env, ctx, caches, cf }` through `cloudflare-runtime`'s
   * platform proxy; when absent (production builds), `emulate()` returns an
   * inert empty platform.
   */
  readonly platform?: CloudflareDevPlatformOptions | undefined;
  /**
   * Effectful-Website wrapper delivery: generate the worker shim's effect
   * arm (see `WorkerShim.ts`). The adapter stands down — emitting the
   * plain shim — when kit's built server graph already mounts
   * `alchemy/Serve` explicitly (the sentinel scan below).
   */
  readonly effect?: WorkerShimEffectOptions | undefined;
}

export interface CloudflareAdapter extends Adapter {
  /** Populated by `adapt()`; consumed by the SvelteKit Framework service. */
  readonly result: { current?: CloudflareAdapterResult };
  /**
   * Tear down dev resources held by the adapter (the platform-proxy workerd
   * instance, when one was opened). Safe to call multiple times; a no-op
   * when the proxy was never opened.
   */
  readonly dispose: () => Promise<void>;
}

/**
 * Render kit's fallback page (the SPA / 404 app shell) in-process.
 *
 * `builder.generateFallback` delegates to a `worker_threads` fork whose
 * ready/args handshake matches messages on the module's `import.meta.url`
 * string. Under bun on Windows the parent and child spell that URL
 * differently, the handshake never completes, and no fallback is written —
 * the deployed site then 404s every client route (the assets layer has no
 * shell to fall back to). These are kit's own `core/postbuild/fallback.js`
 * steps, minus the fork; the build process is short-lived in every context
 * that runs `adapt` (harness build, alchemy source build), so the fork's
 * dangling-handle isolation buys nothing here.
 */
const generateFallbackInProcess = async (
  builder: Builder,
  dest: string,
): Promise<void> => {
  const kit = builder.config.kit;
  const serverRoot = NodePath.join(kit.outDir, "output", "server");
  const load = async (file: string): Promise<Record<string, any>> =>
    await import(
      /* @vite-ignore */ pathToFileURL(NodePath.join(serverRoot, file)).href
    );
  const { set_building } = await load("internal.js");
  const { Server } = await load("index.js");
  const { manifest } = await load("manifest-full.js");

  // kit's builder loads .env files through vite's `loadEnv`; the adapter
  // only runs inside a build, where vite is importable. Fall back to the
  // process env when it isn't (the shell render rarely reads env at all).
  const env: Record<string, string> = await import("vite").then(
    (vite) => vite.loadEnv("production", kit.env.dir, ""),
    () =>
      Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
  );

  set_building();
  const server = new Server(manifest);
  await server.init({ env });
  const origin = kit.paths.origin || "http://sveltekit-prerender";
  const response: Response = await server.respond(
    new Request(`${origin}/[fallback]`),
    {
      getClientAddress: () => {
        throw new Error("Cannot read clientAddress during prerendering");
      },
      prerendering: {
        fallback: true,
        dependencies: new Map(),
        remote_responses: new Map(),
      },
      read: (file: string) =>
        NodeFs.readFileSync(NodePath.join(kit.files.assets, file)),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Could not create a fallback page — failed with status ${response.status}`,
    );
  }
  NodeFs.writeFileSync(dest, await response.text());
};

export const makeCloudflareAdapter = (
  options: CloudflareAdapterOptions = {},
): CloudflareAdapter => {
  const result: { current?: CloudflareAdapterResult } = {};
  let emulator: CloudflareEmulator | undefined;
  return {
    name: "@alchemy.run/frontend-frameworks/sveltekit",
    result,
    async adapt(builder: Builder) {
      const root = options.root ?? process.cwd();
      const assetsBinding = options.assetsBinding ?? "ASSETS";
      // Effectful wrapper delivery is ADDITIVE-ONLY (Serve/DESIGN.md): the
      // shim grafts kit's handler verbatim — the user's hooks.server.ts
      // mount owns HTTP — and only contributes the platform surface. Two
      // bridges on one worker is no longer possible, so nothing is
      // detected or stood down.
      const effect = options.effect;
      const dest = builder.getBuildDirectory("cloudflare");
      const tmp = builder.getBuildDirectory("cloudflare-tmp");

      builder.rimraf(dest);
      builder.rimraf(tmp);
      builder.mkdirp(dest);
      builder.mkdirp(tmp);

      // client assets and prerendered pages
      const assetsDest = dest + builder.config.kit.paths.base;
      builder.mkdirp(assetsDest);
      if (options.notFoundHandling === "404-page") {
        // generate plaintext 404.html first, which can then be overridden by
        // prerendering if the user defined such a page
        const fallback = NodePath.join(assetsDest, "404.html");
        if (options.fallback === "spa") {
          await generateFallbackInProcess(builder, fallback);
        } else {
          NodeFs.writeFileSync(fallback, "Not Found");
        }
      }
      builder.writeClient(assetsDest);
      builder.writePrerendered(assetsDest);
      if (options.notFoundHandling === "single-page-application") {
        await generateFallbackInProcess(
          builder,
          NodePath.join(assetsDest, "index.html"),
        );
      }

      // manifest module
      NodeFs.writeFileSync(
        NodePath.join(tmp, "manifest.js"),
        `export const manifest = ${builder.generateManifest({
          relativePath: posixify(
            NodePath.relative(tmp, builder.getServerDirectory()),
          ),
        })};\n\n` +
          `export const prerendered = new Set(${JSON.stringify(builder.prerendered.paths)});\n\n` +
          `export const base_path = ${JSON.stringify(builder.config.kit.paths.base)};\n`,
      );

      // worker entry (unbundled shim; relative imports into `output/server`)
      const workerEntry = NodePath.join(dest, "_worker.js");
      NodeFs.writeFileSync(
        workerEntry,
        generateWorkerShim({
          serverImport: `./${posixify(NodePath.relative(dest, builder.getServerDirectory()))}/index.js`,
          manifestImport: `./${posixify(NodePath.relative(dest, tmp))}/manifest.js`,
          assetsBinding,
          notFoundHandling: options.notFoundHandling,
          effect,
        }),
      );
      if (
        typeof builder.hasServerInstrumentationFile === "function" &&
        builder.hasServerInstrumentationFile()
      ) {
        builder.instrument({
          entrypoint: workerEntry,
          instrumentation: NodePath.join(
            builder.getServerDirectory(),
            "instrumentation.server.js",
          ),
        });
      }

      // _headers
      const userHeaders = readOptionalFile(NodePath.join(root, "_headers"));
      NodeFs.writeFileSync(
        NodePath.join(dest, "_headers"),
        generateHeaders(builder.getAppPath(), userHeaders),
      );

      // _redirects
      const userRedirects = readOptionalFile(NodePath.join(root, "_redirects"));
      const redirects = generateRedirects(
        builder.prerendered.redirects,
        userRedirects,
      );
      if (redirects !== undefined) {
        NodeFs.writeFileSync(NodePath.join(dest, "_redirects"), redirects);
      }

      // Workers-mode assets ignore file
      NodeFs.writeFileSync(
        NodePath.join(dest, ".assetsignore"),
        generateAssetsIgnore(),
      );

      result.current = {
        dest,
        workerEntry,
        effect:
          options.effect !== undefined
            ? {
                active: effect !== undefined,
                exportNames:
                  effect !== undefined
                    ? [
                        ...(effect.durableObjects ?? []),
                        ...(effect.workflows ?? []),
                      ]
                    : [],
              }
            : undefined,
      };
    },
    emulate: () =>
      (emulator ??=
        options.platform !== undefined
          ? makeDevPlatformEmulator(options.platform)
          : makeBuildEmulator()),
    dispose: async () => {
      await emulator?.dispose();
    },
    supports: {
      read: () => true,
      instrumentation: () => true,
    },
  };
};

const readOptionalFile = (path: string): string | undefined =>
  NodeFs.existsSync(path) ? NodeFs.readFileSync(path, "utf8") : undefined;

const posixify = (str: string): string => str.replace(/\\/g, "/");

/**
 * Add a rule block for `url` to a `_headers` file, merging into an existing
 * block for the same URL if present (upstream `append_headers`).
 */
export const appendHeaders = (
  url: string,
  rules: Array<string>,
  content: string,
): string => {
  const regex = new RegExp(`^(${url.replaceAll("*", "\\*")})$`, "m");
  const formattedHeaders = rules.map((rule) => `  ${rule}`).join("\n");

  // if the URL already exists, just add header rules to it
  if (regex.test(content)) {
    return content.replace(regex, `$1\n${formattedHeaders}`);
  }

  // otherwise, we add the url and header rules
  return `
${content}
# === START AUTOGENERATED SVELTE IMMUTABLE HEADERS ===
${url}
${formattedHeaders}
# === END AUTOGENERATED SVELTE IMMUTABLE HEADERS ===
`.trim();
};

/**
 * Merge the user's `_headers` content with the generated kit rules
 * (`noindex` for the app dir, immutable caching for hashed assets).
 */
export const generateHeaders = (appDir: string, content = ""): string => {
  content = appendHeaders(
    `/${appDir}/*`,
    ["X-Robots-Tag: noindex", "Cache-Control: no-cache"],
    content,
  );
  content = appendHeaders(
    `/${appDir}/immutable/*`,
    ["! Cache-Control", "Cache-Control: public, immutable, max-age=31536000"],
    content,
  );
  return content;
};

/**
 * Merge the user's `_redirects` content with rules for kit's prerendered
 * redirects. Returns `undefined` when there is nothing to write.
 */
export const generateRedirects = (
  redirects: Map<string, { status: number; location: string }>,
  content?: string,
): string | undefined => {
  const parts: Array<string> = [];
  if (content !== undefined) {
    parts.push(content);
  }
  if (redirects.size > 0) {
    const rules = Array.from(
      redirects.entries(),
      ([path, redirect]) => `${path} ${redirect.location} ${redirect.status}`,
    ).join("\n");
    parts.push(
      `
# === START AUTOGENERATED SVELTE PRERENDERED REDIRECTS ===
${rules}
# === END AUTOGENERATED SVELTE PRERENDERED REDIRECTS ===
`.trimEnd(),
    );
  }
  if (parts.length === 0) {
    return undefined;
  }
  return parts.join("\n");
};

/** Workers-mode `.assetsignore`: files in `dest` that are not static assets. */
export const generateAssetsIgnore = (): string =>
  `
_worker.js
_routes.json
_headers
_redirects
`.trimStart();

// ---------------------------------------------------------------------------
// Dev platform emulation (cloudflare-runtime platform proxy)
// ---------------------------------------------------------------------------

/** Inputs for the proxy-backed dev platform served from `emulate()`. */
export interface CloudflareDevPlatformOptions {
  /**
   * Literal `platform.env` overrides. Applied on top of the proxied binding
   * values — a same-named literal always wins (back-compat with the phase-1
   * stub platform, whose env was literals only).
   */
  readonly env?: Record<string, unknown> | undefined;
  /**
   * Bindings to expose on `platform.env` — the same hook shapes
   * `cloudflare-runtime`'s `Runtime.start` accepts (`Text.local`,
   * `KvNamespace.local`, `D1.local`, remote bindings, …). Typed opaquely
   * because the specs travel through the target-agnostic framework half;
   * the values must be `cloudflare-runtime` `BindingHooks`.
   */
  readonly bindings?: ReadonlyArray<unknown> | undefined;
  /**
   * Pre-built `Context<RuntimeServices>` to host the proxy in (opaque —
   * travels through the target-agnostic framework half). Enables
   * remote()-lowered bindings, which the proxy's internal local-only layer
   * cannot serve.
   */
  readonly services?: unknown;
  /** Compatibility date for the binding-proxy workerd instance. */
  readonly compatibilityDate?: string | undefined;
  /** Compatibility flags for the binding-proxy workerd instance. */
  readonly compatibilityFlags?: ReadonlyArray<string> | undefined;
  /** Name of the proxy workerd service. @default "sveltekit-dev-platform-proxy" */
  readonly name?: string | undefined;
  /**
   * Override how the platform proxy is opened. A test seam — the default
   * dynamically imports `cloudflare-runtime`'s `getPlatformProxy`.
   */
  readonly openProxy?: OpenDevPlatformProxy | undefined;
  /**
   * The site's platform half, hosted INSIDE the proxy workerd
   * (Serve/DESIGN.md tier B dev): a bundled module exporting the
   * DO/Workflow bridge classes and delegating queue batches to the
   * program. Built lazily on the first `platform()` call.
   */
  readonly hostedPlatform?: DevHostedPlatformOptions | undefined;
}

/** Inputs for the dev platform worker hosted in the proxy workerd. */
export interface DevHostedPlatformOptions {
  /** Absolute path of the user's backend module (the impl anchor). */
  readonly main: string;
  /** Durable Object class names the program registered. */
  readonly durableObjects: ReadonlyArray<string>;
  /** Workflow class names the program registered. */
  readonly workflows: ReadonlyArray<string>;
  /** DO namespace configs for the hosting workerd (className/sql/…). */
  readonly durableObjectNamespaces?: ReadonlyArray<unknown> | undefined;
  /** Workflow configs (workflowName/className) for the local engine. */
  readonly workflowConfigs?: ReadonlyArray<unknown> | undefined;
  /** Queues the program consumes — delivered to the hosted module. */
  readonly queueConsumers?: ReadonlyArray<unknown> | undefined;
}

/** The subset of `cloudflare-runtime`'s `PlatformProxy` the emulator serves. */
export interface DevPlatformProxy {
  readonly env: Record<string, unknown>;
  readonly cf: Record<string, unknown>;
  readonly ctx: unknown;
  readonly caches: unknown;
  readonly dispose: () => Promise<void>;
}

export interface OpenDevPlatformProxyOptions {
  readonly name: string;
  readonly compatibilityDate?: string | undefined;
  readonly compatibilityFlags?: ReadonlyArray<string> | undefined;
  readonly bindings: ReadonlyArray<unknown>;
  /** See {@link CloudflareDevPlatformOptions.services}. */
  readonly services?: unknown;
  /** Hosted platform modules (first module exports the DO/WF classes). */
  readonly modules?: ReadonlyArray<unknown> | undefined;
  readonly durableObjectNamespaces?: ReadonlyArray<unknown> | undefined;
  readonly workflows?: ReadonlyArray<unknown> | undefined;
  readonly queueConsumers?: ReadonlyArray<unknown> | undefined;
}

export type OpenDevPlatformProxy = (
  options: OpenDevPlatformProxyOptions,
) => Promise<DevPlatformProxy>;

/** A kit `Emulator` that owns a disposable platform proxy. */
export interface CloudflareEmulator extends Emulator {
  /** Tear down the proxy. No-op when it was never opened. */
  readonly dispose: () => Promise<void>;
}

/**
 * The default proxy opener: `cloudflare-runtime`'s `getPlatformProxy`
 * (workerd hosting the bindings behind the internal proxy worker, local-only
 * layer, state in a temp directory). Imported lazily so production builds
 * never load the runtime machinery.
 */
const openPlatformProxy: OpenDevPlatformProxy = async (options) => {
  const { getPlatformProxy } =
    await import("@alchemy.run/cloudflare-runtime/core/platform-proxy");
  return await getPlatformProxy({
    name: options.name,
    ...(options.compatibilityDate !== undefined
      ? { compatibilityDate: options.compatibilityDate }
      : undefined),
    ...(options.compatibilityFlags !== undefined
      ? { compatibilityFlags: [...options.compatibilityFlags] }
      : undefined),
    bindings: options.bindings as BindingHooks,
    ...(options.services !== undefined
      ? {
          services: options.services as Parameters<
            typeof getPlatformProxy
          >[0]["services"],
        }
      : undefined),
    ...(options.modules !== undefined
      ? { modules: options.modules as any }
      : undefined),
    ...(options.durableObjectNamespaces !== undefined
      ? { durableObjectNamespaces: options.durableObjectNamespaces as any }
      : undefined),
    ...(options.workflows !== undefined
      ? { workflows: options.workflows as any }
      : undefined),
    ...(options.queueConsumers !== undefined
      ? { queueConsumers: options.queueConsumers as any }
      : undefined),
  });
};

/**
 * Bundle the dev platform worker (Serve/DESIGN.md tier B dev): a small
 * generated entry exporting the DO/Workflow bridge classes and a default
 * whose `queue`/`scheduled` delegate into the program — rolldown-bundled
 * for workerd exactly like the deploy finish pass, once per dev session.
 */
const buildHostedPlatformModules = async (
  hosted: DevHostedPlatformOptions,
  options: {
    readonly compatibilityDate?: string | undefined;
    readonly compatibilityFlags?: ReadonlyArray<string> | undefined;
  },
): Promise<ReadonlyArray<{ name: string; type: string; content: string }>> => {
  const [{ rolldown }, { default: cloudflare }, os, fs, path] =
    await Promise.all([
      import("rolldown"),
      import("@alchemy.run/cloudflare-runtime/rolldown"),
      import("node:os"),
      import("node:fs/promises"),
      import("node:path"),
    ]);
  const doClasses = [...hosted.durableObjects];
  const wfClasses = [...hosted.workflows];
  const cfImports = [
    ...(doClasses.length > 0 ? ["DurableObject"] : []),
    ...(wfClasses.length > 0 ? ["WorkflowEntrypoint"] : []),
  ];
  const entrySource = [
    `import { makeWebsiteEntryExports${doClasses.length > 0 ? ", DurableObjectBridge" : ""}${wfClasses.length > 0 ? ", WorkflowBridge" : ""} } from "alchemy/Serve/Worker";`,
    ...(cfImports.length > 0
      ? [`import { ${cfImports.join(", ")} } from "cloudflare:workers";`]
      : []),
    `import Site from ${JSON.stringify(hosted.main)};`,
    // Plain base: this default is constructed manually by the proxy
    // entry's delegation (never registered as a workerd entrypoint), so
    // it must not extend WorkerEntrypoint.
    "class __Base { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }",
    "export default makeWebsiteEntryExports(__Base, {",
    "  site: Site,",
    '  fetch: () => new Response("alchemy platform worker", { status: 404 }),',
    "});",
    ...(doClasses.length > 0
      ? [
          "const __do = DurableObjectBridge(DurableObject, { site: Site });",
          ...doClasses.map(
            (name) =>
              `export class ${name} extends __do(${JSON.stringify(name)}) {}`,
          ),
        ]
      : []),
    ...(wfClasses.length > 0
      ? [
          "const __wf = WorkflowBridge(WorkflowEntrypoint, { site: Site });",
          ...wfClasses.map(
            (name) =>
              `export class ${name} extends __wf(${JSON.stringify(name)}) {}`,
          ),
        ]
      : []),
    "",
  ].join("\n");
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "alchemy-platform-"));
  const ENTRY_ID = "alchemy:dev-platform-entry";
  const RESOLVED_ENTRY_ID = `\0${ENTRY_ID}`;
  const bundle = await rolldown({
    input: ENTRY_ID,
    // workerd resolve conditions + `cloudflare:` externals — mirrors the
    // deploy target's bundle config; without them platform-node resolves
    // node-flavored and the proxy workerd refuses to boot.
    resolve: {
      conditionNames: ["workerd", "worker", "module", "browser"],
    },
    external: [/^cloudflare:/],
    plugins: [
      {
        name: "alchemy:dev-platform-entry",
        resolveId: (id: string) =>
          id === ENTRY_ID ? RESOLVED_ENTRY_ID : undefined,
        load: (id: string) =>
          id === RESOLVED_ENTRY_ID ? entrySource : undefined,
      },
      cloudflare({
        ...(options.compatibilityDate !== undefined
          ? { compatibilityDate: options.compatibilityDate }
          : undefined),
        compatibilityFlags: [
          ...(options.compatibilityFlags ?? ["nodejs_compat"]),
        ],
        exports: ["default", ...doClasses, ...wfClasses],
      }),
    ],
  });
  try {
    const { output } = await bundle.write({
      dir: outDir,
      format: "esm",
      entryFileNames: "platform.js",
      chunkFileNames: "platform-chunks/[name].js",
      sourcemap: false,
    });
    const modules: Array<{ name: string; type: string; content: string }> = [];
    for (const chunk of output) {
      if (chunk.type !== "chunk") continue;
      modules.push({
        name: chunk.fileName,
        type: "ESModule",
        content: chunk.code,
      });
    }
    // The entry must be FIRST (the proxy composes exports from modules[0]).
    modules.sort((a, b) =>
      a.name === "platform.js" ? -1 : b.name === "platform.js" ? 1 : 0,
    );
    return modules;
  } finally {
    await bundle.close();
    await fs.rm(outDir, { recursive: true, force: true });
  }
};

/**
 * `platform.env` for prerenderable routes: any key access throws (mirroring
 * upstream), because prerendered pages must not depend on request-time
 * bindings.
 */
const guardPrerenderEnv = (
  env: Record<string, unknown>,
): Record<string, unknown> => {
  const guarded: Record<string, unknown> = {};
  for (const key of Object.keys(env)) {
    Object.defineProperty(guarded, key, {
      get: () => {
        throw new Error(
          `Cannot access platform.env.${key} in a prerenderable route`,
        );
      },
    });
  }
  return guarded;
};

/**
 * The dev-platform emulator: serves `platform = { env, ctx, caches, cf }`
 * from `cloudflare-runtime`'s platform proxy — our wrangler-free equivalent
 * of upstream `adapter-cloudflare`'s `getPlatformProxy`-based `emulate()`.
 *
 * - The proxy (a workerd instance hosting the bindings) is opened lazily on
 *   the first `platform()` call and shared across requests; dispose it with
 *   the dev server via {@link CloudflareEmulator.dispose}.
 * - `env` carries every configured binding, callable from Node
 *   (`env.KV.get("key")`, `env.DB.prepare("...").all()`); literal
 *   `options.env` values override same-named proxied values.
 * - `caches` actually round-trips (`put`/`match`/`delete` hit an in-memory
 *   store in the proxy worker — unlike wrangler, whose dev `caches` is a
 *   no-op); `cf` is the same mock object miniflare falls back to; `ctx` is
 *   wrangler's no-op `ExecutionContext` mock.
 * - Inherited proxy limitations: binding methods returning rich class
 *   instances (e.g. `R2Object`) are unsupported, and intermediate values
 *   (e.g. `DurableObjectId`) need an explicit `await` before synchronous use
 *   — see `cloudflare-runtime/platform-proxy`.
 */
export const makeDevPlatformEmulator = (
  options: CloudflareDevPlatformOptions = {},
): CloudflareEmulator => {
  const openProxy = options.openProxy ?? openPlatformProxy;
  let opened: Promise<DevPlatformProxy> | undefined;
  const open = () =>
    (opened ??= (async () => {
      const hosted = options.hostedPlatform;
      const platformModules =
        hosted !== undefined &&
        (hosted.durableObjects.length > 0 ||
          hosted.workflows.length > 0 ||
          (hosted.queueConsumers?.length ?? 0) > 0)
          ? await buildHostedPlatformModules(hosted, {
              compatibilityDate: options.compatibilityDate,
              compatibilityFlags: options.compatibilityFlags,
            })
          : undefined;
      return openProxy({
        name: options.name ?? "sveltekit-dev-platform-proxy",
        compatibilityDate: options.compatibilityDate,
        compatibilityFlags: options.compatibilityFlags,
        bindings: options.bindings ?? [],
        services: options.services,
        ...(platformModules !== undefined && hosted !== undefined
          ? {
              modules: platformModules,
              durableObjectNamespaces: hosted.durableObjectNamespaces,
              workflows: hosted.workflowConfigs,
              queueConsumers: hosted.queueConsumers,
            }
          : undefined),
      }).catch((error) => {
        // A proxy boot failure otherwise surfaces as an opaque 500 on
        // every request — put the runtime's own stderr on the console.
        console.error(
          "[alchemy] dev platform proxy failed to start:",
          error,
          (error as { detail?: unknown })?.detail,
        );
        throw error;
      });
    })());
  return {
    platform: async ({ prerender }) => {
      const proxy = await open();
      const env = { ...proxy.env, ...options.env };
      return {
        env: prerender ? guardPrerenderEnv(env) : env,
        ctx: proxy.ctx,
        caches: proxy.caches,
        cf: proxy.cf,
      } as unknown as App.Platform;
    },
    dispose: async () => {
      if (opened === undefined) return;
      const proxy = await opened.catch(() => undefined);
      await proxy?.dispose();
    },
  };
};

/**
 * The inert platform used when the adapter is constructed without dev
 * platform options (production builds): empty env, no-op `ctx`/`caches`,
 * empty `cf`. Never opens a proxy.
 */
const makeBuildEmulator = (): CloudflareEmulator => {
  const noopCache = {
    match: async () => undefined,
    put: async () => {},
    delete: async () => false,
  };
  const platform = {
    env: {},
    ctx: {
      waitUntil: (_promise: Promise<unknown>) => {},
      passThroughOnException: () => {},
    },
    caches: {
      default: noopCache,
      open: async () => noopCache,
    },
    cf: {},
  };
  return {
    platform: () => platform as unknown as App.Platform,
    dispose: async () => {},
  };
};
