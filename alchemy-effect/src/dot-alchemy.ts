import * as FileSystem from "@effect/platform/FileSystem";
import * as Path from "@effect/platform/Path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export class DotAlchemy extends Context.Tag(".alchemy")<DotAlchemy, string>() {}

export const dotAlchemy = Layer.effect(
  DotAlchemy,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = path.join(process.cwd(), ".alchemy");
    yield* fs.makeDirectory(dir, { recursive: true });
    return dir;
  }),
);
