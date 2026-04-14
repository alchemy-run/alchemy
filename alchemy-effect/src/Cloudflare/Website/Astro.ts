import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import { Command, type CommandProps } from "../../Build/Command.ts";
import type { InputProps } from "../../Input.ts";
import * as Namespace from "../../Namespace.ts";
import type { AssetsConfig } from "../Workers/Assets.ts";
import {
  Worker,
  type WorkerAssetsConfig,
  type WorkerBindingProps,
  type WorkerProps,
} from "../Workers/Worker.ts";

export interface AstroProps<Bindings extends WorkerBindingProps = {}>
  extends
    Omit<WorkerProps<Bindings, WorkerAssetsConfig>, "assets" | "main">,
    Omit<CommandProps, "command" | "outdir" | "env"> {
  /**
   * The Worker entrypoint. Defaults based on `output`:
   * - `"server"`: `<outdir>/_worker.js/index.js` (the `@astrojs/cloudflare` adapter output)
   * - `"static"`: a generated no-op placeholder at `.alchemy/local/worker.js`
   */
  main?: string;
  /**
   * Astro adapter output mode. Auto-detected from `astro.config.{mjs,js,ts,mts}`
   * when omitted. Falls back to `"static"` if no config file is found.
   */
  output?: "server" | "static";
  /**
   * Build command. Defaults to `"bun astro build"`.
   */
  command?: string;
  /**
   * Output directory produced by the build. Defaults to `"dist"`.
   */
  outdir?: string;
  /**
   * Optional asset routing configuration (HTML handling, not-found handling,
   * `runWorkerFirst`, etc.) passed through to the underlying Worker.
   */
  assetsConfig?: AssetsConfig;
}

export type Astro = ReturnType<typeof Astro>;

/**
 * A Cloudflare Worker deployed from an Astro project.
 *
 * `Astro` runs `astro build`, content-hashes the inputs, and deploys the
 * resulting `dist/` directory as a Cloudflare Worker with static assets.
 *
 * When the Astro config declares `output: "server"`, the `@astrojs/cloudflare`
 * adapter emits the server bundle at `<outdir>/_worker.js/index.js` and this
 * resource points the Worker entrypoint at it. Because those adapter files
 * sit inside the assets directory, the build command is augmented to write a
 * `.assetsignore` that excludes `_worker.js`, `_worker.js.map`, and
 * `_routes.json` from the static asset upload.
 *
 * For static sites a no-op placeholder Worker is generated at
 * `.alchemy/local/worker.js` so the assets have a host.
 *
 * @resource
 *
 * @section Basic Usage
 * Point it at an Astro project and Alchemy handles the build and deploy.
 * The output mode is auto-detected from `astro.config.*`.
 *
 * @example Deploying an Astro site
 * ```typescript
 * const site = yield* Cloudflare.Astro("Site");
 * ```
 *
 * @section Server Output
 * For server-rendered Astro (`output: "server"` with `@astrojs/cloudflare`),
 * enable `nodejs_compat` so the adapter bundle can use Node.js APIs at runtime.
 *
 * @example Server-rendered Astro
 * ```typescript
 * const site = yield* Cloudflare.Astro("Site", {
 *   output: "server",
 *   compatibility: {
 *     flags: ["nodejs_compat"],
 *   },
 * });
 * ```
 *
 * @section Bindings
 * Pass Cloudflare resources through `bindings` the same way you would
 * for a plain Worker. They become available to your Astro server code.
 *
 * @example Astro with R2 and D1
 * ```typescript
 * const bucket = Cloudflare.R2Bucket("Assets");
 * const db = Cloudflare.D1Database("App");
 *
 * const site = yield* Cloudflare.Astro("Site", {
 *   output: "server",
 *   compatibility: { flags: ["nodejs_compat"] },
 *   bindings: { ASSETS_BUCKET: bucket, DB: db },
 * });
 * ```
 *
 * @section Custom Build Command
 * Override `command` for projects that run Astro through a different
 * package manager or wrap it in a script.
 *
 * @example Using pnpm
 * ```typescript
 * const site = yield* Cloudflare.Astro("Site", {
 *   command: "pnpm astro build",
 * });
 * ```
 *
 * @section Custom Rebuild Scope
 * Narrow the input hash to avoid rebuilding on unrelated file changes.
 *
 * @example Narrowing the memo scope
 * ```typescript
 * const site = yield* Cloudflare.Astro("Site", {
 *   memo: {
 *     include: ["src/**", "astro.config.mjs", "package.json"],
 *   },
 * });
 * ```
 */
export const Astro = <const Bindings extends WorkerBindingProps = {}>(
  id: string,
  props: InputProps<AstroProps<Bindings>> = {},
) =>
  Effect.gen(function* () {
    const cwd = NodePath.resolve((props.cwd as string | undefined) ?? process.cwd());
    const outdir = (props.outdir as string | undefined) ?? "dist";
    const baseCommand = (props.command as string | undefined) ?? "bun astro build";
    const output =
      (props.output as "server" | "static" | undefined) ??
      detectOutputMode(cwd);

    // In server mode the `@astrojs/cloudflare` adapter writes the Worker
    // bundle to `<outdir>/_worker.js/` plus a `_routes.json` sibling. The
    // alchemy-effect assets uploader does not know about those files, so
    // without exclusion they'd be served publicly as static assets. Append
    // an `.assetsignore` write to the build command to exclude them.
    const command =
      output === "server" ? `${baseCommand} && ${writeAssetsIgnore(outdir)}` : baseCommand;

    const build = yield* Command("Build", {
      command,
      cwd: props.cwd,
      memo: props.memo,
      outdir,
      env: props.env,
    });

    const main =
      (props.main as string | undefined) ??
      (output === "server"
        ? NodePath.join(cwd, outdir, "_worker.js", "index.js")
        : writePlaceholderWorker(cwd));

    const worker = yield* Worker<Bindings, WorkerAssetsConfig>("Worker", {
      ...props,
      main,
      assets: {
        path: build.outdir,
        hash: build.hash,
        config: props.assetsConfig,
      },
    });

    return worker;
  }).pipe(Namespace.push(id));

const ASTRO_CONFIG_CANDIDATES = [
  "astro.config.mjs",
  "astro.config.js",
  "astro.config.ts",
  "astro.config.mts",
];

const detectOutputMode = (cwd: string): "server" | "static" => {
  for (const candidate of ASTRO_CONFIG_CANDIDATES) {
    const configPath = NodePath.join(cwd, candidate);
    if (!NodeFs.existsSync(configPath)) continue;
    const source = NodeFs.readFileSync(configPath, "utf-8");
    const match = source.match(/output\s*:\s*["'](server|static)["']/);
    if (match) return match[1] as "server" | "static";
    return "static";
  }
  return "static";
};

const PLACEHOLDER_WORKER_CONTENT =
  'export default {\n  async fetch() {\n    return new Response("Not Found", { status: 404 });\n  },\n};\n';

const writePlaceholderWorker = (cwd: string): string => {
  const dir = NodePath.join(cwd, ".alchemy", "local");
  const file = NodePath.join(dir, "worker.js");
  NodeFs.mkdirSync(dir, { recursive: true });
  NodeFs.writeFileSync(file, PLACEHOLDER_WORKER_CONTENT);
  return file;
};

const ASSETS_IGNORE_ENTRIES = [
  "_worker.js",
  "_worker.js/**",
  "_worker.js.map",
  "_routes.json",
];

const posixSingleQuote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

const writeAssetsIgnore = (outdir: string): string => {
  const entries = ASSETS_IGNORE_ENTRIES.map(posixSingleQuote).join(" ");
  const target = posixSingleQuote(`${outdir}/.assetsignore`);
  return `printf '%s\\n' ${entries} > ${target}`;
};
