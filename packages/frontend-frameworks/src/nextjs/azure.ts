/**
 * `@alchemy.run/frontend-frameworks/nextjs/azure` — Next.js on Azure
 * Functions (Flex Consumption) behind Azure Front Door. No OpenNext.
 *
 * - **`build`** runs the project's `next build` with
 *   `NEXT_PRIVATE_STANDALONE` set, so Next traces a self-contained server
 *   directory (`.next/standalone`, with its own `node_modules`) without a
 *   change to `next.config.*`. The standalone server is copied to
 *   `.next/alchemy-azure-server` with a hoisted `node_modules` of real
 *   directories (a Function package keeps no symbolic links, and pnpm links
 *   every package), plus `serve-azure.mjs`: a Fetch module
 *   (`export default { fetch(request) }`) that starts Next in production
 *   mode on the first request and answers every request through Next's
 *   request handler. `Azure.Website.Nextjs` ships that directory as-is next
 *   to the Function's entry, so Next loads its own files at run time.
 *   `public/` and `.next/static` are gathered
 *   into `.next/alchemy-azure-assets` for Blob Storage (`/_next/static/*`
 *   and the `public/` paths), and copied into the server for the image
 *   optimizer.
 * - **`dev`** runs the real `next dev` CLI (see `./node.ts`).
 */
import { createRequire } from "node:module";
import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as ChildProcess from "effect/process/ChildProcess";
import * as Stream from "effect/Stream";
import { makeAzureServeEntrySource, AZURE_SERVE_ENTRY_FILE_NAME } from "../core/AzureServe.ts";
import * as FrameworkCore from "../core/index.ts";
import { make as makeNode, type NextjsNodeOptions } from "./node.ts";

const fail = (message: string) => (cause: unknown) =>
  new FrameworkCore.FrameworkError({ framework: "nextjs", message, cause });

/** The Fetch entry the Function runs, inside the standalone app directory. */
export const SERVE_ENTRY_FILE_NAME = AZURE_SERVE_ENTRY_FILE_NAME;

/** The bundled `srvx/node` adapter the entry imports, next to it. */
export const NODE_ADAPTER_FILE_NAME = "azure-node-adapter.mjs";

/** The directory of files uploaded to Blob Storage, under `.next`. */
export const ASSETS_DIRECTORY = "alchemy-azure-assets";

/** The server directory the Function package ships, under `.next`. */
export const SERVER_DIRECTORY = "alchemy-azure-server";

/**
 * Statements that start Next on the first request and expose `fetchNext`,
 * a Fetch handler over Next's Node request handler. Next's own `next` package
 * is loaded with `require` from the standalone `node_modules`, so a bundler
 * that inlines this module leaves Next on disk.
 */
export const makeNextAzureHandlerSource = (nextConfig: Record<string, unknown>) =>
  [
    'import { createRequire } from "node:module";',
    'import * as path from "node:path";',
    'import { fileURLToPath } from "node:url";',
    `import { toFetchHandler } from "./${NODE_ADAPTER_FILE_NAME}";`,
    "const require = createRequire(import.meta.url);",
    "const dir = path.dirname(fileURLToPath(import.meta.url));",
    'process.env.NODE_ENV = "production";',
    'process.env.NEXT_TELEMETRY_DISABLED = "1";',
    `const nextConfig = ${JSON.stringify(nextConfig)};`,
    // Next reads the resolved build config from here, so it never loads next.config.* at run time.
    "process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(nextConfig);",
    "let started;",
    "const start = () => (started ??= (async () => {",
    "  try { process.chdir(dir); } catch {}",
    '  const loaded = require("next");',
    '  const next = typeof loaded === "function" ? loaded : loaded.default;',
    '  const requestMeta = require("next/dist/server/request-meta.js");',
    "  const app = next({ dev: false, dir, conf: nextConfig });",
    "  await app.prepare();",
    "  return { handler: app.getRequestHandler(), requestMeta };",
    "})().catch(error => { started = undefined; throw error; }));",
    "const fetchNext = async request => {",
    "  const { handler, requestMeta } = await start();",
    "  const url = new URL(request.url);",
    "  return toFetchHandler((req, res) => {",
    "    const protocol = url.protocol.slice(0, -1);",
    "    req.headers.host = url.host;",
    '    req.headers["x-forwarded-host"] = url.host;',
    '    req.headers["x-forwarded-proto"] = protocol;',
    '    req.headers["x-forwarded-port"] = url.port || (protocol === "https" ? "443" : "80");',
    "    const meta = requestMeta.getRequestMeta(req);",
    "    // The Fetch request carries the site URL; Next must not replace it with a listening address.",
    "    Object.defineProperties(meta, {",
    "      initURL: { enumerable: true, get: () => request.url, set() {} },",
    "      initProtocol: { enumerable: true, get: () => protocol, set() {} },",
    "    });",
    "    requestMeta.setRequestMeta(req, meta);",
    "    Promise.resolve(handler(req, res)).catch(error => res.destroy(error));",
    "  })(request);",
    "};",
  ].join("\n");

/** The complete `serve-azure.mjs` for a standalone Next.js server. */
export const makeNextAzureServeEntrySource = (nextConfig: Record<string, unknown>) =>
  `// Generated by @alchemy.run/frontend-frameworks/nextjs/azure — do not edit.\n${makeAzureServeEntrySource(
    {
      handler: {
        kind: "fetch",
        imports: makeNextAzureHandlerSource(nextConfig),
        expr: "fetchNext",
      },
    },
  )}`;

const resolveNextCli = (root: string) =>
  Effect.try({
    try: () => {
      const require = createRequire(`${root.replace(/\/+$/, "")}/package.json`);
      return require.resolve("next/dist/bin/next");
    },
    catch: fail(`Failed to resolve "next" from ${root}. It must be installed in your project.`),
  });

/** Run `next build` to completion, forwarding its output. */
const runNextBuild = (root: string, cli: string, env: Record<string, string>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const child = yield* ChildProcess.make("node", [cli, "build"], {
        cwd: root,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env,
      }).pipe(Effect.mapError(fail("Failed to spawn the next build CLI (is `node` on PATH?)")));
      const forward = (
        stream: Stream.Stream<Uint8Array, PlatformError>,
        dest: NodeJS.WriteStream,
      ) => Stream.runForEach(stream, (chunk) => Effect.sync(() => dest.write(chunk)));
      const { exitCode } = yield* Effect.all(
        {
          exitCode: child.exitCode,
          stdout: forward(child.stdout, process.stdout),
          stderr: forward(child.stderr, process.stderr),
        },
        { concurrency: "unbounded" },
      ).pipe(Effect.mapError(fail("Failed reading the next build output")));
      if (exitCode !== 0) {
        return yield* fail(`The next build exited with code ${exitCode}`)(undefined);
      }
    }),
  );

/** Bundle `srvx/node` (Node `(req, res)` → Fetch) into one ESM file. */
const bundleNodeAdapter = Effect.gen(function* () {
  const adapter = yield* Effect.try({
    try: () => createRequire(import.meta.url).resolve("srvx/node"),
    catch: fail('Failed to resolve "srvx/node"'),
  });
  const bundle = yield* Effect.tryPromise({
    try: () =>
      import("esbuild").then((esbuild) =>
        esbuild.build({
          entryPoints: [adapter],
          bundle: true,
          platform: "node",
          target: "node22",
          format: "esm",
          write: false,
        }),
      ),
    catch: fail("Failed to bundle the srvx Node adapter"),
  });
  return bundle.outputFiles[0]!.contents;
});

/** Copy a directory's contents into another, if it exists. */
const copyInto = (from: string, to: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(from).pipe(Effect.orElseSucceed(() => false)))) return;
    yield* fs.makeDirectory(to, { recursive: true });
    yield* fs.copy(from, to, { overwrite: true });
  });

interface RequiredServerFiles {
  readonly config: Record<string, unknown> & { output?: string };
  readonly relativeAppDir?: string;
}

/**
 * Copy a directory tree, following symbolic links (the copy holds real
 * files only). `skipNodeModules` leaves out the top-level `node_modules`.
 * A dangling link is skipped.
 */
const copyTree = (
  from: string,
  to: string,
  skipNodeModules: boolean,
): Effect.Effect<void, PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(to, { recursive: true });
    for (const name of yield* fs.readDirectory(from)) {
      if (skipNodeModules && name === "node_modules") continue;
      const source = path.join(from, name);
      const info = yield* fs.stat(source).pipe(Effect.option);
      if (info._tag === "None") continue;
      if (info.value.type === "Directory") yield* copyTree(source, path.join(to, name), false);
      else if (info.value.type === "File") yield* fs.copyFile(source, path.join(to, name));
    }
  });

/** Entries of a `node_modules` directory that are not packages. */
const NOT_PACKAGES = new Set([".bin", ".pnpm", ".modules.yaml", ".package-lock.json"]);

/** Package names in a `node_modules` directory (`@scope/name` expanded). */
const packageNames = Effect.fn(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(dir))) return [];
  const names: string[] = [];
  for (const name of [...(yield* fs.readDirectory(dir))].sort()) {
    if (NOT_PACKAGES.has(name)) continue;
    if (name.startsWith("@")) {
      for (const child of [...(yield* fs.readDirectory(`${dir}/${name}`))].sort()) {
        names.push(`${name}/${child}`);
      }
    } else names.push(name);
  }
  return names;
});

/** Node's lookup of package `name` from the real directory `from`, up to `top`. */
const lookupPackage = Effect.fn(function* (name: string, from: string, top: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let dir = from;
  for (;;) {
    const candidate = path.join(dir, "node_modules", name);
    const info = yield* fs.stat(candidate).pipe(Effect.option);
    if (info._tag === "Some" && info.value.type === "Directory")
      return yield* fs.realPath(candidate);
    const parent = path.dirname(dir);
    if (dir === top || parent === dir) return undefined;
    dir = parent;
  }
});

interface DependencyManifest {
  readonly dependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
}

/** The names a package depends on, from its `package.json`. */
const dependencyNames = Effect.fn(function* (packageDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs
    .readFileString(`${packageDir}/package.json`)
    .pipe(Effect.orElseSucceed(() => "{}"));
  const manifest = yield* Effect.try(
    () => JSON.parse(raw) as DependencyManifest,
  ).pipe(Effect.orElseSucceed((): DependencyManifest => ({})));
  return [
    ...new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ]),
  ];
});

/**
 * Write the standalone server to `out` with a `node_modules` tree of real
 * directories. A Function package keeps no symbolic links, and a pnpm
 * install links every package (`node_modules/next -> .pnpm/next@…`), so
 * the traced packages are laid out hoisted instead: each package once at
 * `node_modules/<name>`, and a second version of a name below the package
 * that needs it. Node resolves a package's dependencies from its real
 * location, which this layout keeps resolvable.
 */
const writeServerDirectory = Effect.fn(function* (options: {
  readonly standaloneDir: string;
  readonly appDir: string;
  readonly out: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const top = yield* fs.realPath(options.standaloneDir);
  const appDir = yield* fs.realPath(options.appDir);
  yield* fs.remove(options.out, { recursive: true }).pipe(Effect.ignore);
  yield* copyTree(appDir, options.out, true);

  const hoisted = new Map<string, string>();
  const queue: Array<{ readonly real: string; readonly dest: string }> = [];
  const place = Effect.fn(function* (name: string, real: string, dependent: string | undefined) {
    const existing = hoisted.get(name);
    if (existing === real) return;
    const dest =
      existing === undefined || dependent === undefined
        ? path.join(options.out, "node_modules", name)
        : path.join(dependent, "node_modules", name);
    if (existing === undefined) hoisted.set(name, real);
    else if (yield* fs.exists(dest)) return;
    yield* copyTree(real, dest, true);
    queue.push({ real, dest });
  });

  // Every package the app sees from its own directory.
  let dir = appDir;
  for (;;) {
    for (const name of yield* packageNames(path.join(dir, "node_modules"))) {
      const real = yield* lookupPackage(name, appDir, top);
      if (real !== undefined && !hoisted.has(name)) yield* place(name, real, undefined);
    }
    const parent = path.dirname(dir);
    if (dir === top || parent === dir) break;
    dir = parent;
  }
  // Then their traced dependencies, breadth first.
  for (let index = 0; index < queue.length; index++) {
    const { real, dest } = queue[index]!;
    for (const name of yield* dependencyNames(real)) {
      const dependency = yield* lookupPackage(name, real, top);
      if (dependency !== undefined) yield* place(name, dependency, dest);
    }
  }
});

/**
 * `next build` as a standalone server plus the Azure Functions Fetch entry
 * and the Blob Storage asset directory. Returns paths relative to `.next`.
 */
export const buildAzure = Effect.fn(function* (options: {
  readonly root: string;
  readonly env: Record<string, string> | undefined;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { root } = options;
  const cli = yield* resolveNextCli(root);

  const env = yield* Effect.sync(() => ({
    ...(process.env as Record<string, string>),
    ...options.env,
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    // Next's switch for `output: "standalone"` when the config sets none.
    NEXT_PRIVATE_STANDALONE: "true",
  }));
  yield* runNextBuild(root, cli, env);

  const nextDir = path.join(root, ".next");
  const serverFilesPath = path.join(nextDir, "required-server-files.json");
  const raw = yield* fs
    .readFileString(serverFilesPath)
    .pipe(Effect.mapError(fail(`The next build produced no ${serverFilesPath}`)));
  const serverFiles = yield* Effect.try({
    try: () => JSON.parse(raw) as RequiredServerFiles,
    catch: fail(`Failed to parse ${serverFilesPath}`),
  });
  if (serverFiles.config.output === "export") {
    return yield* fail(
      '`output: "export"` builds a static site with no Next server. Remove it from next.config, or deploy the exported `out/` directory with `Azure.Website.StaticSite`.',
    )(undefined);
  }
  if (serverFiles.config.output !== "standalone") {
    return yield* fail(
      `next.config sets output: "${serverFiles.config.output}". Azure Functions runs Next's standalone server; remove output, or set it to "standalone".`,
    )(undefined);
  }
  // In a monorepo Next traces from the workspace root, so the app sits
  // below `.next/standalone` at its path relative to that root.
  const standaloneDir = path.join(nextDir, "standalone");
  const appDir = path.join(standaloneDir, serverFiles.relativeAppDir ?? "");
  if (!(yield* fs.exists(path.join(appDir, "server.js")).pipe(Effect.orElseSucceed(() => false)))) {
    return yield* fail(`The next build produced no standalone server in ${appDir}`)(undefined);
  }
  const serverDir = path.join(nextDir, SERVER_DIRECTORY);
  yield* writeServerDirectory({ standaloneDir, appDir, out: serverDir }).pipe(
    Effect.mapError(fail("Failed to lay out the standalone server for Azure Functions")),
  );

  // Next's image optimizer reads local images from its own server directory.
  yield* copyInto(path.join(root, "public"), path.join(serverDir, "public")).pipe(
    Effect.mapError(fail("Failed to copy public/ into the server")),
  );
  yield* copyInto(path.join(nextDir, "static"), path.join(serverDir, ".next", "static")).pipe(
    Effect.mapError(fail("Failed to copy .next/static into the server")),
  );
  // The Function package is `"type": "module"`; Next's compiled server files are CommonJS.
  yield* fs
    .writeFileString(
      path.join(serverDir, ".next", "package.json"),
      `${JSON.stringify({ type: "commonjs" })}\n`,
    )
    .pipe(Effect.mapError(fail("Failed to mark .next as CommonJS")));

  const adapter = yield* bundleNodeAdapter;
  yield* fs
    .writeFile(path.join(serverDir, NODE_ADAPTER_FILE_NAME), adapter)
    .pipe(Effect.mapError(fail("Failed to write the srvx Node adapter")));
  yield* fs
    .writeFileString(
      path.join(serverDir, SERVE_ENTRY_FILE_NAME),
      makeNextAzureServeEntrySource(serverFiles.config),
    )
    .pipe(Effect.mapError(fail("Failed to write the Azure Functions entry")));

  // Blob Storage serves `public/` at the root and the hashed build files
  // under `/_next/static`.
  const assets = path.join(nextDir, ASSETS_DIRECTORY);
  yield* fs.remove(assets, { recursive: true }).pipe(Effect.ignore);
  yield* fs
    .makeDirectory(assets, { recursive: true })
    .pipe(Effect.mapError(fail("Failed to create the asset directory")));
  yield* copyInto(path.join(root, "public"), assets).pipe(
    Effect.mapError(fail("Failed to gather public/ for upload")),
  );
  yield* copyInto(path.join(nextDir, "static"), path.join(assets, "_next", "static")).pipe(
    Effect.mapError(fail("Failed to gather .next/static for upload")),
  );

  return {
    distDirectory: nextDir,
    clientDirectory: assets,
    serverModules: [{ name: `${SERVER_DIRECTORY}/${SERVE_ENTRY_FILE_NAME}` }],
  };
});

/** Options for the Next.js Azure framework module. */
export interface NextjsAzureOptions extends NextjsNodeOptions {}

/**
 * The framework-module contract `Azure.Website.Nextjs` drives: `build` for
 * Azure Functions, `dev` as `next dev`.
 */
export const make = Effect.fn(function* (options: NextjsAzureOptions = {}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const node = yield* makeNode(options);
  const services = Layer.mergeAll(
    Layer.succeed(FileSystem.FileSystem)(fs),
    Layer.succeed(Path.Path)(path),
  );
  const layer = Layer.mergeAll(
    services,
    NodeChildProcessSpawner.layer.pipe(Layer.provide(services)),
  );
  return {
    dev: node.dev,
    build: (buildOptions?: FrameworkCore.FrameworkBuildOptions) =>
      Effect.gen(function* () {
        const root = yield* Effect.sync(() =>
          path.resolve(buildOptions?.root ?? options.root ?? process.cwd()),
        );
        return yield* buildAzure({ root, env: buildOptions?.env });
      }).pipe(Effect.provide(layer)),
  };
});

export default make;
