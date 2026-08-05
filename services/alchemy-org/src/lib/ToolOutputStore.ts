import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

export interface OutputArtifact {
  readonly id: string;
  readonly append: (chunk: string) => Effect.Effect<void, string>;
}

export class ToolOutputStore extends Context.Service<
  ToolOutputStore,
  {
    readonly create: (label: string) => Effect.Effect<OutputArtifact, string>;
    readonly read: (id: string) => Effect.Effect<string, string>;
    readonly size: (id: string) => Effect.Effect<number, string>;
  }
>()("alchemy-org/ToolOutputStore") {}

/**
 * Local artifact store. Host paths never reach the model: tools
 * return opaque IDs consumed by `ReadOutput`.
 *
 * Deliberately NOT a scoped temp directory: layer construction is
 * isolate-scoped, and a scoped dir's finalizer runs when the
 * CONSTRUCTING scope closes — right after init on the local service —
 * deleting the store out from under every long-lived run that pipes
 * tool output through it. The OS owns temp cleanup.
 */
export const ToolOutputStoreLive = Layer.effect(
  ToolOutputStore,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectory({
      prefix: "alchemy-tool-output-",
    });
    const files = new Map<string, string>();
    let next = 1;

    return {
      create: (label) =>
        Effect.gen(function* () {
          const safe = label.replaceAll(/[^a-zA-Z0-9_-]/g, "-");
          const id = `output-${next++}-${safe}`;
          const file = path.join(root, `${id}.log`);
          yield* fs
            .writeFileString(file, "")
            .pipe(Effect.mapError((error) => String(error)));
          files.set(id, file);
          return {
            id,
            append: (chunk) =>
              fs
                .writeFileString(file, chunk, { flag: "a" })
                .pipe(Effect.mapError((error) => String(error))),
          };
        }),
      read: (id) => {
        const file = files.get(id);
        return file === undefined
          ? Effect.fail(`unknown output artifact: ${id}`)
          : fs
              .readFileString(file)
              .pipe(Effect.mapError((error) => String(error)));
      },
      size: (id) => {
        const file = files.get(id);
        return file === undefined
          ? Effect.fail(`unknown output artifact: ${id}`)
          : fs.stat(file).pipe(
              Effect.map((info) => Number(info.size)),
              Effect.mapError((error) => String(error)),
            );
      },
    };
  }),
);
