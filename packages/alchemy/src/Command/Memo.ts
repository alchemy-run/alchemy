import * as Effect from "effect/Effect";
import { dotAlchemyDirectory } from "../AlchemyContext.ts";
import { initialCwd } from "../Util/Node.ts";
import * as Path from "effect/Path";
import {
  hashDirectory as hashSourceDirectory,
  type MemoOptions,
} from "@alchemy.run/node-utils/memo";
export type { MemoOptions } from "@alchemy.run/node-utils/memo";

/** Hash source files while excluding this stack's runtime storage directory. */
export const hashDirectory = Effect.fn(function* (props: {
  cwd?: string;
  memo?: MemoOptions;
}) {
  const path = yield* Path.Path;
  const runtimeDirectory = yield* dotAlchemyDirectory;
  return yield* hashSourceDirectory({
    ...props,
    cwd: path.resolve(initialCwd, props.cwd ?? "."),
    runtimeDirectory,
  });
});
