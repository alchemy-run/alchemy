import * as esbuild from "esbuild";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { hashDirectory } from "../../Build/Memo.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { cloudflareNodeJSCompatPlugin } from "./CloudflareNodeJSCompatPlugin.ts";

export interface OpenNextBundleProps {
  /**
   * Absolute path to the OpenNext-emitted worker entry (typically
   * `<projectRoot>/.open-next/worker.js`). Accepts an `Input<string>`
   * so it can be wired to another resource's output (e.g.
   * `Build.Command`'s `outdir`) for proper dependency ordering.
   */
  entry: string;
  /**
   * Absolute path to the output directory. The bundled entry is
   * written as `<outdir>/worker.js`.
   */
  outdir: string;
  /**
   * workerd compatibility config used to configure the
   * `@cloudflare/unenv-preset` Node.js polyfills (must include
   * `nodejs_compat`).
   */
  compatibility?: {
    date?: string;
    flags?: string[];
  };
}

export interface OpenNextBundle extends Resource<
  "Cloudflare.OpenNextBundle",
  OpenNextBundleProps,
  {
    /** Absolute path to the bundled worker entry (`<outdir>/worker.js`). */
    main: string;
    /** Absolute path to the output directory. */
    outdir: string;
    /** Hash of the input files that produced this bundle. */
    hash: string;
  }
> {}

/**
 * Bundles an OpenNext-emitted Cloudflare Worker entry in-process using
 * esbuild + `@cloudflare/unenv-preset` + the vendored
 * `nodejsHybridPlugin` — the same building blocks wrangler uses
 * internally, with no `wrangler` subprocess.
 */
export const OpenNextBundle = Resource<OpenNextBundle>(
  "Cloudflare.OpenNextBundle",
);

export const OpenNextBundleProvider = () =>
  Provider.effect(
    OpenNextBundle,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const resolveProps = (props: OpenNextBundleProps) => {
        const entry = path.resolve(props.entry);
        const outdir = path.resolve(props.outdir);
        const cwd = path.dirname(entry);
        const main = path.join(outdir, "worker.js");
        return { cwd, entry, outdir, main };
      };

      const runBundle = Effect.fn(function* (props: OpenNextBundleProps) {
        const { cwd, entry, outdir, main } = resolveProps(props);
        yield* fs.makeDirectory(outdir, { recursive: true });
        yield* Effect.tryPromise({
          try: () =>
            esbuild.build({
              entryPoints: [entry],
              bundle: true,
              format: "esm",
              target: "es2024",
              platform: "neutral",
              outfile: main,
              conditions: ["workerd", "worker", "browser"],
              mainFields: ["module", "main"],
              external: ["__STATIC_CONTENT_MANIFEST", "cloudflare:*"],
              loader: {
                ".js": "jsx",
                ".mjs": "jsx",
                ".cjs": "jsx",
                ".wasm": "copy",
              },
              supported: { "import-source": true },
              define: {
                "process.env.NODE_ENV": '"production"',
                "global.process.env.NODE_ENV": '"production"',
                "globalThis.process.env.NODE_ENV": '"production"',
              },
              plugins: [
                cloudflareNodeJSCompatPlugin({
                  compatibilityDate: props.compatibility?.date,
                  compatibilityFlags: props.compatibility?.flags ?? [],
                }),
              ],
              logLevel: "warning",
              absWorkingDir: cwd,
            }),
          catch: (e) =>
            new Error(
              `Cloudflare.OpenNextBundle bundle failed: ${e instanceof Error ? e.message : String(e)}`,
            ),
        });
        return { main, outdir };
      });

      return OpenNextBundle.Provider.of({
        stables: ["outdir"],
        diff: Effect.fnUntraced(function* ({ news, output }) {
          if (!isResolved(news)) return undefined;
          if (!output) return undefined;
          const { entry } = resolveProps(news);
          const newHash = yield* hashDirectory({
            cwd: path.dirname(entry),
            memo: { include: ["**/*"] },
          });
          if (newHash !== output.hash) {
            return { action: "update" as const };
          }
          return undefined;
        }),
        read: Effect.fnUntraced(function* ({ olds, output }) {
          if (!output) return undefined;
          const { main, outdir } = resolveProps(olds);
          const exists = yield* fs.exists(main);
          if (!exists) return undefined;
          return { ...output, main, outdir };
        }),
        create: Effect.fnUntraced(function* ({ news, session }) {
          const { entry } = resolveProps(news);
          yield* session.note(`Bundling ${entry} (in-process esbuild)`);
          const { main, outdir } = yield* runBundle(news);
          const hash = yield* hashDirectory({
            cwd: path.dirname(entry),
            memo: { include: ["**/*"] },
          });
          yield* session.note(`Bundle complete: ${main}`);
          return { main, outdir, hash };
        }),
        update: Effect.fnUntraced(function* ({ news, session }) {
          const { entry } = resolveProps(news);
          yield* session.note(`Re-bundling ${entry} (in-process esbuild)`);
          const { main, outdir } = yield* runBundle(news);
          const hash = yield* hashDirectory({
            cwd: path.dirname(entry),
            memo: { include: ["**/*"] },
          });
          yield* session.note(`Bundle complete: ${main}`);
          return { main, outdir, hash };
        }),
        delete: Effect.fnUntraced(function* ({ output, session }) {
          const exists = yield* fs.exists(output.outdir);
          if (exists) {
            yield* fs.remove(output.outdir, { recursive: true });
            yield* session.note(`Removed bundle output: ${output.outdir}`);
          }
        }),
      });
    }),
  );
