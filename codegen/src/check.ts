import * as Effect from "effect/Effect";
import { sourcePath, testPath } from "./paths.ts";
import * as Command from "@effect/platform/Command";

export const checkTypes = (service: string, resource: string) =>
  Effect.gen(function* () {
    const src = yield* sourcePath(service, `${resource}.ts`);
    const providerSrc = yield* sourcePath(service, `${resource}.provider.ts`);
    const testFile = yield* testPath(service, `${resource}.test.ts`);

    const command = Command.make(
      "bun",
      "tsc",
      "--noEmit",
      src,
      providerSrc,
      testFile,
      "2>&1",
    ).pipe(Command.runInShell(true));

    const stdout = yield* Command.string(command);

    if (stdout.match(/Found (\d+) errors?/)) {
      return stdout;
    }
    return undefined;
  });
