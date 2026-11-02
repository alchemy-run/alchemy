import * as Effect from "effect/Effect";
import type { BuildOutput } from "../core/BuildOutput.ts";
import { finishStackitOutput, makeStackitTarget } from "../core/StackitServe.ts";
import { makeNodeTarget } from "./node.ts";

const finish = (output: BuildOutput) =>
  finishStackitOutput({
    ...output,
    nodeServe: {
      ...output.nodeServe,
      // Kit emits extensionless prerendered routes as .html files.
      htmlHandling: "drop-trailing-slash",
    },
  });

/** SvelteKit's Node handler on a STACKIT Function behind the CDN. */
export const target = (config?: Parameters<typeof makeNodeTarget>[0]) => {
  const node = makeNodeTarget(config);
  return {
    ...makeStackitTarget(node),
    build: (context: Parameters<NonNullable<typeof node.build>>[0]) =>
      node.build!(context).pipe(Effect.flatMap(finish)),
    finish: (...args: Parameters<NonNullable<typeof node.finish>>) =>
      node.finish!(...args).pipe(Effect.flatMap(finish)),
  };
};
export default target;
