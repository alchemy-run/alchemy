import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { DevBox } from "./DevBox.ts";
import { ReleaseBlogger } from "./ReleaseBlogger.ts";
import { EvalLive } from "./tools/Eval.ts";
import { WriteFileDevBox } from "./tools/Fs.ts";
import { GrepLive } from "./tools/Grep.ts";
import { SqlDurableObjectLive } from "./tools/Sql.ts";

/**
 * TODO(sam/harness): the AI term redesign made agents `Context.Service`
 * tags — `yield* ReleaseBlogger` now resolves a live ProcessService from
 * context instead of embodying the agent inline. This example predates
 * the Kernel; until the Cloudflare kernel Layer lands, the blogger is a
 * pending-migration stub (compiles, dies loudly if invoked).
 */
const pending = (verb: string) =>
  Effect.die(
    new Error(
      `cloudflare-agent example pending migration to the AI kernel: ${verb}`,
    ),
  );
const ReleaseBloggerPendingMigration = Layer.succeed(ReleaseBlogger, {
  dispatch: () => pending("dispatch"),
  send: () => pending("send"),
  run: () => pending("run"),
  steer: () => pending("steer"),
  interrupt: () => pending("interrupt"),
});

export class ReleaseVersion extends Cloudflare.DurableObject<ReleaseVersion>()(
  "ReleaseBlogger",
  Effect.gen(function* () {
    const blogger = yield* ReleaseBlogger;

    return Effect.gen(function* () {
      return {
        generateBlog: Effect.fn(function* (request: { input: any }) {
          yield* blogger.send(request);
        }),
      };
    });
  }).pipe(
    Effect.provide(
      SqlDurableObjectLive.pipe(
        Layer.provideMerge(ReleaseBloggerPendingMigration),
        Layer.provideMerge(WriteFileDevBox),
        Layer.provideMerge(GrepLive),
        Layer.provideMerge(EvalLive),
        Layer.provideMerge(Cloudflare.AI.layerChatDurableObject),
        Layer.provideMerge(
          Cloudflare.Containers.layer(DevBox, {
            enableInternet: true,
          }),
        ),
      ),
    ),
  ),
) {}
