/**
 * The tier-B dev hosted platform worker for Nuxt (Serve/DESIGN.md): the
 * site's platform half — DO/Workflow bridge classes and the queue/
 * scheduled delegation — bundled for workerd and hosted INSIDE the dev
 * platform proxy, so Durable Objects, Workflows, and queue consumers have
 * real semantics under `alchemy dev` while nitro's own dev server keeps
 * HTTP + HMR. Copy-adapted from the SvelteKit adapter's hosted platform
 * (`../../sveltekit/Adapter.ts`), which pioneered the pattern.
 */

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

/** Whether the hosted platform worker has anything to host. */
export const hasHostedSurface = (hosted: DevHostedPlatformOptions): boolean =>
  hosted.durableObjects.length > 0 ||
  hosted.workflows.length > 0 ||
  (hosted.queueConsumers?.length ?? 0) > 0;

/**
 * Bundle the dev platform worker: a small generated entry exporting the
 * DO/Workflow bridge classes and a default whose `queue`/`scheduled`
 * delegate into the program — rolldown-bundled for workerd exactly like
 * the deploy finish pass, once per dev session.
 */
export const buildHostedPlatformModules = async (
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
