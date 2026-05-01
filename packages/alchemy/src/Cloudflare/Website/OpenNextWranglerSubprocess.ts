import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { Command } from "../../Build/Command.ts";
import * as Namespace from "../../Namespace.ts";
import * as Output from "../../Output.ts";
import {
  Worker,
  type WorkerAssetsConfig,
  type WorkerBindingProps,
  type WorkerProps,
} from "../Workers/Worker.ts";

export interface OpenNextWranglerSubprocessProps<
  Bindings extends WorkerBindingProps = {},
> extends Omit<
    WorkerProps<Bindings, WorkerAssetsConfig>,
    "main" | "bundle" | "assets"
  > {
  /**
   * Project root containing `next.config.{js,mjs,ts}` and
   * `open-next.config.ts`. Defaults to the current working directory.
   */
  cwd?: string;
  /**
   * Build command that produces `.open-next/`.
   *
   * @default "next build && opennextjs-cloudflare build"
   */
  buildCommand?: string;
  /**
   * Wrangler invocation that produces a self-contained worker bundle
   * from `.open-next/`. Must write its output to `.open-next-bundled/`
   * (or whichever path you configure here — the resource resolves the
   * worker entry as `<bundleOutdir>/worker.js`).
   *
   * @default "wrangler deploy --dry-run --outdir=.open-next-bundled"
   */
  bundleCommand?: string;
  /**
   * Output directory used by `bundleCommand`. Must match the path
   * passed to `--outdir`.
   *
   * @default ".open-next-bundled"
   */
  bundleOutdir?: string;
}

/**
 * A Cloudflare Worker deployed from a Next.js app via OpenNext, using
 * a **wrangler subprocess** to bundle the worker.
 *
 * `OpenNextWranglerSubprocess` runs `next build && opennextjs-cloudflare
 * build` to produce `.open-next/`, then spawns
 * `wrangler deploy --dry-run --outdir=.open-next-bundled` to let
 * wrangler's `bundleWorker` (esbuild + `nodejsHybridPlugin` +
 * `@cloudflare/unenv-preset`) produce a self-contained `worker.js`.
 * That bundle is uploaded via `Cloudflare.Worker` with `bundle: false`.
 *
 * Compared to {@link OpenNext} (in-process), this variant:
 *
 *   • Always tracks wrangler's `bundleWorker` exactly — no risk of
 *     drift from an internal plugin we vendor ourselves.
 *   • Requires a `wrangler.{toml,jsonc}` (or
 *     `open-next.config.ts`-generated equivalent) on disk so wrangler
 *     can pick up the entry/compatibility config.
 *   • Spawns a Node.js subprocess on every (non-memoized) deploy.
 *
 * @section Basic Usage
 * @example
 * ```typescript
 * const app = yield* Cloudflare.OpenNextWranglerSubprocess("MyApp", {});
 * ```
 *
 * @section Custom Build / Bundle
 * @example
 * ```typescript
 * const app = yield* Cloudflare.OpenNextWranglerSubprocess("MyApp", {
 *   buildCommand: "turbo run build:worker",
 *   bundleCommand:
 *     "wrangler deploy --dry-run --outdir=dist/worker --config wrangler.production.jsonc",
 *   bundleOutdir: "dist/worker",
 * });
 * ```
 */
export const OpenNextWranglerSubprocess = <
  const Bindings extends WorkerBindingProps = {},
  Req = never,
>(
  id: string,
  propsEff?:
    | OpenNextWranglerSubprocessProps<Bindings>
    | Effect.Effect<OpenNextWranglerSubprocessProps<Bindings>, never, Req>,
) =>
  Effect.gen(function* () {
    const props = yield* (Effect.isEffect(propsEff)
      ? propsEff
      : Effect.succeed(
          propsEff ?? ({} as OpenNextWranglerSubprocessProps<Bindings>),
        ));

    const path = yield* Path.Path;
    const cwd = props.cwd ? path.resolve(props.cwd) : process.cwd();
    const bundleOutdirRel = props.bundleOutdir ?? ".open-next-bundled";

    // 1. opennextjs-cloudflare build → .open-next/
    const build = yield* Command("OpenNextBuild", {
      command:
        props.buildCommand ?? "next build && opennextjs-cloudflare build",
      cwd: props.cwd,
      outdir: ".open-next",
    });

    // 2. wrangler bundleWorker → <bundleOutdir>/worker.js
    //
    //    Note: `wrangler deploy --dry-run --outdir=...` is the only
    //    public, documented contract for getting a wrangler-bundled
    //    output without actually deploying. Wrangler does NOT export
    //    `bundleWorker` (or the underlying `esbuild` plugins) from its
    //    npm package — `unstable_dev` / `getPlatformProxy` are the
    //    only public entry points and neither produces a bundle.
    //
    //    The `command` is wired through `build.outdir` so this Command
    //    is correctly ordered after the OpenNext build.
    const bundleCommandStr =
      props.bundleCommand ??
      `wrangler deploy --dry-run --outdir=${bundleOutdirRel}`;
    const bundle = yield* Command("WranglerBundle", {
      command: Output.map(build.outdir, () => bundleCommandStr),
      cwd: props.cwd,
      outdir: bundleOutdirRel,
    });

    // 3. Upload the wrangler-produced bundle via Worker with
    //    `bundle: false`. Static assets continue to be served from
    //    `.open-next/assets`.
    return yield* Worker<Bindings, WorkerAssetsConfig, Req>("Worker", {
      ...props,
      main: Output.map(bundle.outdir, (dir) => path.join(dir, "worker.js")),
      bundle: false as const,
      // Pass the assets directory + hash through `build`'s outputs so
      // the dependency on the OpenNext build is correctly tracked
      // (avoids reading `.open-next/assets` during plan when the build
      // hasn't run yet).
      assets: {
        path: Output.map(build.outdir, (dir) => path.join(dir, "assets")),
        hash: build.hash,
        config: {
          notFoundHandling: "none",
          htmlHandling: "auto-trailing-slash",
          runWorkerFirst: false,
        },
      },
    });
  }).pipe(Namespace.push(id));
