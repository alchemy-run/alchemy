import * as AI from "@alchemy.run/ai";
import * as AICloudflare from "@alchemy.run/ai/Cloudflare";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as OpenCode from "@alchemy.run/opencode";
import * as OpenCodeCloudflare from "@alchemy.run/opencode/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";

class Fast extends AI.Model<Fast>()("fast") {}

/** An OpenCode harness whose `AI.Bash` was given another harness's own tool: it compiles, and must not run. */
export class OpenCodeWrongHarness extends Cloudflare.DurableObject<OpenCodeWrongHarness>()(
  "OpenCodeWrongHarness",
  Effect.gen(function* () {
    const harness = yield* OpenCode.Harness({ models: [Fast], tools: [AI.Bash] });

    return Effect.gen(function* () {
      return { id: () => harness.session("any").id };
    });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        AICloudflare.Model(Fast, { model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" }),
        OpenCodeCloudflare.DurableObjectStorage,
        AI.Bash.native("pi", "bash"),
      ),
    ),
  ),
) {}

export default class OpenCodeWrongHarnessApi extends Cloudflare.Worker<OpenCodeWrongHarnessApi>()(
  "OpenCodeWrongHarnessApi",
  { main: import.meta.url },
  Effect.gen(function* () {
    const sessions = yield* OpenCodeWrongHarness;
    return {
      fetch: Effect.gen(function* () {
        return yield* HttpServerResponse.json(yield* sessions.getByName("any").id());
      }).pipe(Effect.orDie),
    };
  }),
) {}
