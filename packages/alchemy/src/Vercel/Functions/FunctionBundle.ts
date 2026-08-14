/**
 * Vercel Function code bundling.
 *
 * **Async (external) mode**: the user's `main` module exports web-standard
 * handlers (`{ fetch }`, method exports, or `(req, res)`) that Vercel's
 * Node launcher accepts natively, so there is NO generated bridge: the
 * module is bundled as-is with the shared rolldown machinery
 * (`src/Bundle`) and shipped as `index.mjs` inside `functions/index.func/`.
 *
 * **Effect mode** (`isExternal` unset): a virtual entry wraps the user's
 * `main` with the Vercel runtime bridge (DESIGN §6.4):
 *
 * ```ts
 * import entrypoint from "<user main>";
 * import { makeVercelBridge } from "alchemy/Vercel";
 * export default makeVercelBridge(entrypoint, { stack: { name, stage } });
 * ```
 *
 * The bridge emits a web-standard, streaming-capable `{ fetch }` export;
 * deploy-time halves of the init Effect are DCE'd out of the shipped
 * bundle via the `__ALCHEMY_RUNTIME__` define.
 */
import * as Effect from "effect/Effect";
import * as Bundle from "../../Bundle/Bundle.ts";
import * as TempRoot from "../../Bundle/TempRoot.ts";
import { Stack } from "../../Stack.ts";
import { Stage } from "../../Stage.ts";
import { sha256 } from "../../Util/sha256.ts";
import type { FunctionProps } from "./Function.ts";

export interface FunctionBundleResult {
  /** Identity hash driving change detection in `diff`. */
  readonly identityHash: string;
  /** Module files relative to `index.func/` — entry is `index.mjs`. */
  readonly files: ReadonlyArray<{ path: string; bytes: Uint8Array }>;
}

const encoder = new TextEncoder();

const toBytes = (content: string | Uint8Array): Uint8Array =>
  typeof content === "string" ? encoder.encode(content) : content;

/**
 * Which bridge the generated entry mounts: `"fetch"` (default) is the public
 * HTTP function; `"queue"` is the dedicated queue-consumer function (D9a) —
 * same user module, but the bridge dispatches CloudEvent queue deliveries to
 * the init-registered `subscribe` handlers instead of user `fetch`.
 */
export type FunctionBundleVariant = "fetch" | "queue";

export const makeFunctionBundler = Effect.gen(function* () {
  const virtualEntryPlugin = yield* Bundle.virtualEntryPlugin;

  const bundleFunctionCode: (
    id: string,
    props: FunctionProps,
    variant?: FunctionBundleVariant,
  ) => Effect.Effect<FunctionBundleResult, any, any> = Effect.fn(function* (
    _id: string,
    props: FunctionProps,
    variant?: FunctionBundleVariant,
  ) {
    // Inline script: shipped verbatim, no bundling.
    if (props.script !== undefined) {
      if (variant === "queue") {
        return yield* Effect.die(
          "Vercel queue subscriptions require an Effect-mode `main` Function — inline `script` cannot carry the generated consumer bundle",
        );
      }
      const bytes = encoder.encode(props.script);
      return {
        identityHash: yield* sha256(bytes),
        files: [{ path: "index.mjs", bytes }],
      } satisfies FunctionBundleResult;
    }
    if (props.main === undefined) {
      return yield* Effect.die(
        "Vercel.Function requires one of `main`, `script`, or `prebuilt`",
      );
    }
    if (variant === "queue" && props.isExternal) {
      return yield* Effect.die(
        "Vercel queue subscriptions require an Effect-mode Function (a class/inline impl) — async-mode Functions have no init Effect to register `subscribe` handlers",
      );
    }

    const realMain = yield* TempRoot.resolveMainPath(props.main);
    const cwd = yield* TempRoot.findCwdForBundle(realMain);
    const {
      output: buildOutput,
      pure: _pure,
      bundleAnalyzer: _bundleAnalyzer,
      ...inputOptions
    } = props.build ?? {};

    // Effect mode: wrap `main` with the runtime bridge via a virtual entry.
    // Async (external) mode ships the user's module as the entry directly.
    let entryPlugin: ReturnType<typeof virtualEntryPlugin> | undefined;
    if (!props.isExternal) {
      const stack = yield* Stack;
      const stage = yield* Stage;
      entryPlugin = virtualEntryPlugin(
        (importPath) => `
import entrypoint from ${JSON.stringify(importPath)};
import { makeVercelBridge } from "alchemy/Vercel";

export default makeVercelBridge(entrypoint, {
  stack: {
    name: ${JSON.stringify(stack.name)},
    stage: ${JSON.stringify(stage)},
  },${variant === "queue" ? `\n  mode: "queue",` : ""}
});
`,
      );
    }

    const bundleOutput = yield* Bundle.build(
      {
        ...inputOptions,
        input: realMain,
        cwd,
        platform: "node",
        plugins: [inputOptions.plugins, entryPlugin],
        resolve: {
          ...inputOptions.resolve,
          conditionNames: [
            "bun",
            ...(
              inputOptions.resolve?.conditionNames ?? [
                "node",
                "import",
                "module",
                "default",
              ]
            ).filter((condition) => condition !== "bun"),
          ],
        },
      },
      {
        ...buildOutput,
        format: "esm",
        sourcemap: buildOutput?.sourcemap ?? false,
        minify: buildOutput?.minify ?? false,
        entryFileNames: "index.mjs",
        chunkFileNames: buildOutput?.chunkFileNames ?? "[name]-[hash].mjs",
        codeSplitting: buildOutput?.codeSplitting ?? false,
      },
      props.build,
    );

    return {
      identityHash: bundleOutput.hash,
      files: bundleOutput.files.map((file) => ({
        path: file.path,
        bytes: toBytes(file.content),
      })),
    } satisfies FunctionBundleResult;
  });

  return { bundleFunctionCode };
});
