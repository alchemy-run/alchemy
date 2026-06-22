import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { DevBox } from "./DevBox.ts";
import { ReleaseBlogger } from "./ReleaseBlogger.ts";
import { EvalLive } from "./tools/Eval.ts";
import { WriteFileDevBox } from "./tools/Fs.ts";
import { GrepLive } from "./tools/Grep.ts";
import { SqlDurableObjectLive } from "./tools/Sql.ts";

export class ReleaseVersion extends Cloudflare.DurableObjectNamespace<ReleaseVersion>()(
  "ReleaseBlogger",
  Effect.gen(function* () {
    const blogger = yield* ReleaseBlogger;
    const state = yield* Cloudflare.DurableObjectState;

    return Effect.gen(function* () {
      // RuntimeContext
      const sockets = yield* state.getWebSockets();

      return {
        generateBlog: Effect.fn(function* (request: { input: any }) {
          const isStarted = yield* state.storage.get<boolean>("isStarted");
          // request
          if (!isStarted) {
            yield* blogger.send(request);
            yield* state.storage.put("isStarted", true);
            for (const socket of sockets) {
              yield* socket.send("Blog generated");
            }
          }
        }),
      };
    });
  }).pipe(
    Effect.provide(
      SqlDurableObjectLive.pipe(
        Layer.provideMerge(WriteFileDevBox),
        Layer.provideMerge(GrepLive),
        Layer.provideMerge(EvalLive),
        Layer.provideMerge(Cloudflare.layerChatDurableObject),
        Layer.provideMerge(
          Cloudflare.layerContainer(DevBox, {
            enableInternet: true,
          }),
        ),
      ),
    ),
  ),
) {}
