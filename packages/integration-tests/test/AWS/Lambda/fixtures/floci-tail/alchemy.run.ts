/**
 * Stack entrypoint for the `alchemy logs --tail` case in
 * [Function.local.test.ts](../../Function.local.test.ts). The test drives it
 * through the same Alchemist routes as `alchemy dev` and `alchemy logs`.
 */
import { fileURLToPath } from "node:url";
import * as AWS from "@alchemy.run/aws";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "FlociLogTail",
  { providers: AWS.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const fn = yield* AWS.Lambda.Function("TailFn", {
      main: fileURLToPath(new URL("./handler.ts", import.meta.url)),
      handler: "handler",
      isExternal: true,
      functionUrl: true,
    });
    return { functionUrl: fn.functionUrl };
  }),
);
