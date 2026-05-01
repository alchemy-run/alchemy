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
import { OpenNextBundle } from "./OpenNextBundle.ts";

export interface OpenNextProps<Bindings extends WorkerBindingProps = {}>
  extends Omit<
    WorkerProps<Bindings, WorkerAssetsConfig>,
    "main" | "bundle" | "assets"
  > {
  /**
   * Project root containing `next.config.{js,mjs,ts}` and
   * `open-next.config.ts`. Defaults to the current working directory.
   */
  cwd?: string;
  /**
   * Build command that produces `.open-next/`. Override if you need a
   * non-standard pipeline (custom Next.js compiler, a turbo task, etc).
   *
   * @default "next build && opennextjs-cloudflare build"
   */
  buildCommand?: string;
}

/**
 * A Cloudflare Worker deployed from a Next.js app via OpenNext, using
 * an **in-process bundler**.
 *
 * `OpenNext` runs `next build && opennextjs-cloudflare build` to produce
 * the `.open-next/` artifacts, then bundles the worker entry in-process
 * via {@link OpenNextBundle} (esbuild + `@cloudflare/unenv-preset` +
 * the vendored hybrid plugin — the same building blocks wrangler uses
 * internally), and uploads the result via `Cloudflare.Worker` with
 * `bundle: false`.
 *
 * No `wrangler` subprocess is spawned for bundling — alchemy is the
 * only deploy tool in the loop.
 *
 * @section Basic Usage
 * @example
 * ```typescript
 * const app = yield* Cloudflare.OpenNext("MyApp", {});
 * ```
 *
 * @section Custom Build Command
 * @example
 * ```typescript
 * const app = yield* Cloudflare.OpenNext("MyApp", {
 *   buildCommand: "turbo run build:worker",
 * });
 * ```
 */
export const OpenNext = <
  const Bindings extends WorkerBindingProps = {},
  Req = never,
>(
  id: string,
  propsEff?:
    | OpenNextProps<Bindings>
    | Effect.Effect<OpenNextProps<Bindings>, never, Req>,
) =>
  Effect.gen(function* () {
    const props = yield* (Effect.isEffect(propsEff)
      ? propsEff
      : Effect.succeed(propsEff ?? ({} as OpenNextProps<Bindings>)));

    const path = yield* Path.Path;
    const cwd = props.cwd ? path.resolve(props.cwd) : process.cwd();

    // 1. Run `opennextjs-cloudflare build` (memoized on input hash).
    const build = yield* Command("OpenNextBuild", {
      command:
        props.buildCommand ?? "next build && opennextjs-cloudflare build",
      cwd: props.cwd,
      outdir: ".open-next",
    });

    // 2. Bundle `.open-next/worker.js` in-process via the
    //    `Cloudflare.OpenNextBundle` resource (esbuild +
    //    `@cloudflare/unenv-preset` + vendored hybrid plugin).
    //    `entry` is wired to `build.outdir` so the bundle resource is
    //    correctly ordered after the build.
    const bundle = yield* OpenNextBundle("Bundle", {
      entry: Output.map(build.outdir, (dir) => path.join(dir, "worker.js")),
      outdir: path.join(cwd, ".open-next-bundled"),
      compatibility: props.compatibility,
    });

    // 3. Upload the self-contained bundle via `Cloudflare.Worker` with
    //    `bundle: false`. Static assets continue to be served from
    //    `.open-next/assets`.
    return yield* Worker<Bindings, WorkerAssetsConfig, Req>("Worker", {
      ...props,
      main: bundle.main,
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
