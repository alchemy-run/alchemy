import * as Effect from "effect/Effect";
import * as Path from "@effect/platform/Path";

export const designPath = (service: string, doc: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return path.join("alchemy-effect", "design", "aws", service, doc);
  });

export const sourcePath = (service: string, file: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return path.join("alchemy-effect", "src", "aws", service, file);
  });

export const testPath = (service: string, file: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return path.join("alchemy-effect", "test", "aws", service, file);
  });

export const lifecyclePaths = (service: string, resource: string) =>
  Effect.all([
    designPath(service, `${resource}.diff.md`),
    designPath(service, `${resource}.read.md`),
    designPath(service, `${resource}.pre-create.md`),
    designPath(service, `${resource}.create.md`),
    designPath(service, `${resource}.update.md`),
    designPath(service, `${resource}.delete.md`),
  ]);
