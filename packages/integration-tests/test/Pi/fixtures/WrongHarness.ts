import * as AI from "@alchemy.run/ai";
import * as AICloudflare from "@alchemy.run/ai/Cloudflare";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as OpenCode from "@alchemy.run/opencode";
import * as Pi from "@alchemy.run/pi";
import * as PiCloudflare from "@alchemy.run/pi/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { Fast } from "./models.ts";

/** A Pi harness whose `AI.Bash` was given OpenCode's Layer: it compiles, and must not run. */
export class PiWrongHarness extends Cloudflare.DurableObject<PiWrongHarness>()(
  "PiWrongHarness",
  Effect.gen(function* () {
    const harness = yield* Pi.Harness({ models: [Fast], tools: [AI.Bash] });

    return Effect.gen(function* () {
      return { list: () => harness.listConversations };
    });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        AICloudflare.Model(Fast, { model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" }),
        PiCloudflare.DurableObjectStorage,
        OpenCode.Bash,
      ),
    ),
  ),
) {}

export default class PiWrongHarnessApi extends Cloudflare.Worker<PiWrongHarnessApi>()(
  "PiWrongHarnessApi",
  { main: import.meta.url },
  Effect.gen(function* () {
    const sessions = yield* PiWrongHarness;
    return {
      fetch: Effect.gen(function* () {
        return yield* HttpServerResponse.json(yield* sessions.getByName("any").list());
      }).pipe(Effect.orDie),
    };
  }),
) {}
