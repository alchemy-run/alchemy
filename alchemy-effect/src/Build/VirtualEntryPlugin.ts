import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import assert from "node:assert";
import * as rolldown from "rolldown";

const ENTRY_MODULE_ID = "virtual:alchemy-entry";
const ENTRY_MODULE_REGEX = new RegExp(`^${ENTRY_MODULE_ID}$`);

export const virtualEntryPlugin = Effect.gen(function* () {
  const path = yield* Path.Path;
  return (content: (importPath: string) => string) => {
    let importPath: string | undefined;
    return {
      name: "alchemy:virtual-entry",
      options(inputOptions) {
        assert(
          typeof inputOptions.input === "string",
          "input must be a string",
        );
        importPath = `./${path.relative(inputOptions.cwd ?? process.cwd(), inputOptions.input)}`;
        inputOptions.input = ENTRY_MODULE_ID;
      },
      resolveId: {
        filter: { id: ENTRY_MODULE_REGEX },
        handler() {
          return { id: ENTRY_MODULE_ID };
        },
      },
      load: {
        filter: { id: ENTRY_MODULE_REGEX },
        handler() {
          assert(importPath !== undefined, "importPath must be defined");
          return { code: content(importPath), moduleType: "ts" };
        },
      },
    } satisfies rolldown.Plugin;
  };
});
