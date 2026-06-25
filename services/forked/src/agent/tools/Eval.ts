import * as AI from "alchemy/AI";
import * as Cloudflare from "alchemy/Cloudflare";
import { dedent } from "alchemy/Util";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as S from "effect/Schema";
import { HttpClientRequest } from "effect/unstable/http";

export const code = AI.Parameter("code", S.String)`
The JavaScript code to evaluate. Must be a valid ES module with a default-export
function that takes no arguments. It can return any value, including a Promise.`;

export class Eval extends AI.Tool<Eval>()("eval")`
Evaluate JavaScript ${code} in a fresh, sandboxed Worker isolate and return its
console output and result. Useful for quick checks without touching the repo.` {}

export const EvalLive = Layer.effect(
  Eval,
  Effect.gen(function* () {
    const loader = yield* Cloudflare.WorkerLoader("Eval");

    return Effect.fn("eval")(function* (params) {
      const { code } = params as { code: string };
      const worker = yield* loader.load({
        mainModule: "index.js",
        compatibilityDate: "2026-01-28",
        // Block the dynamic isolate from reaching the network.
        globalOutbound: null,
        modules: {
          "code.js": code,
          "index.js": dedent`
            import util from "node:util";
            import code from "./code.js";
            const lines = [];
            console.log = (...args) =>
              lines.push(util.formatWithOptions({ depth: null }, ...args));
            export default {
              fetch: async () => {
                const output = await code();
                return new Response(
                  lines.join("\\n") + "\\n" + util.inspect(output, { depth: null }),
                );
              },
            };`,
        },
      });

      return yield* worker.fetch(HttpClientRequest.get("https://worker/")).pipe(
        Effect.flatMap((response) => response.text),
        Effect.catch((err) => Effect.succeed({ error: err.message })),
      );
    });
  }),
);
