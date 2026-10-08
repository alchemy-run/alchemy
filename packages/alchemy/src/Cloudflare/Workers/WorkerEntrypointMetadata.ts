import type * as workers from "@distilled.cloud/cloudflare/workers";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import type { BundleFile } from "../../Bundle/Bundle.ts";
import type { WorkerProps } from "./Worker.ts";

export class WorkerEntrypointConfigError extends Data.TaggedError(
  "WorkerEntrypointConfigError",
)<{ message: string }> {}

/** Lower the public configuration without changing worker-wide cache defaults. */
export const workerEntrypointMetadata = (
  entrypoints: WorkerProps["entrypoints"],
): workers.PutScriptMetadata["exports"] =>
  entrypoints && Object.keys(entrypoints).length > 0
    ? Object.fromEntries(
        Object.entries(entrypoints).map(([name, { cache }]) => [
          name,
          { type: "worker", cache },
        ]),
      )
    : undefined;

/** Validate the actual uploaded module, including re-exports between its files. */
export const validateWorkerEntrypoints = Effect.fn(function* (
  props: Pick<WorkerProps, "entrypoints" | "exports" | "preview" | "namespace">,
  files: readonly Pick<BundleFile, "path" | "content">[] | undefined,
) {
  const names = Object.keys(props.entrypoints ?? {});
  if (names.length === 0) return;
  if (props.preview?.of != null || props.namespace !== undefined) {
    return yield* new WorkerEntrypointConfigError({
      message:
        "Worker entrypoints cache settings require a script or script version upload. Preview and dispatch namespace upload metadata do not yet support this field in the SDK.",
    });
  }
  const path = yield* Path.Path;
  const { parseSync } = yield* Effect.promise(() => import("rolldown/utils"));
  const known = yield* Effect.try({
    try: () => {
      const modules = new Map(
        files?.map((file) => [path.normalize(file.path), file]),
      );
      const visited = new Set<string>();
      const exports = new Set<string>();
      const visit = (filename: string, entry: boolean) => {
        if (visited.has(filename)) return;
        visited.add(filename);
        const file = modules.get(filename);
        if (!file) {
          throw new Error(
            `Cannot inspect re-exported module '${filename}'. Include it in the uploaded bundle.`,
          );
        }
        const parsed = parseSync(
          filename,
          typeof file.content === "string"
            ? file.content
            : new TextDecoder().decode(file.content),
          { sourceType: "module" },
        );
        if (parsed.errors.length > 0) {
          throw new Error(
            parsed.errors.map((error) => error.message).join("; "),
          );
        }
        for (const exported of parsed.module.staticExports.flatMap(
          (item) => item.entries,
        )) {
          if (exported.isType) continue;
          const name =
            exported.exportName.kind === "Default"
              ? "default"
              : exported.exportName.name;
          if (name !== null) {
            if (entry || name !== "default") exports.add(name);
          } else if (exported.moduleRequest) {
            visit(
              path.normalize(
                path.join(path.dirname(filename), exported.moduleRequest.value),
              ),
              false,
            );
          }
        }
      };
      if (files?.[0]) visit(path.normalize(files[0].path), true);
      return [...exports].sort();
    },
    catch: (cause) =>
      new WorkerEntrypointConfigError({
        message: `Cannot validate Worker entrypoints (${names.join(", ")}): ${String(cause)}`,
      }),
  });
  for (const name of names) {
    if (!known.includes(name)) {
      return yield* new WorkerEntrypointConfigError({
        message: `Worker entrypoint '${name}' is not exported by the bundle. Known exports: ${known.join(", ") || "(none)"}.`,
      });
    }
    if (Object.hasOwn(props.exports ?? {}, name)) {
      return yield* new WorkerEntrypointConfigError({
        message: `Worker entrypoint '${name}' is a Durable Object or Workflow export and cannot receive Worker cache settings.`,
      });
    }
  }
});
