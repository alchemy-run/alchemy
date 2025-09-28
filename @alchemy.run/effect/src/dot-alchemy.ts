import { FileSystem } from "@effect/platform";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import path from "node:path";

export class DotAlchemy extends Context.Tag(".alchemy")<DotAlchemy, string>() {}

export const dotAlchemy = Layer.effect(
  DotAlchemy,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = path.join(process.cwd(), ".alchemy");
    yield* fs.makeDirectory(dir, { recursive: true });
    return dir;
  }),
);
