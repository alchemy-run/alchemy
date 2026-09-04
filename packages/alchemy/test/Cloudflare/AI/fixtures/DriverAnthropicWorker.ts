/**
 * The SAME org as {@link DriverAgents}, a REAL model: Scribe over
 * Anthropic instead of the deterministic prompt-reader — nothing else
 * changes, which is the point of the layered driver.
 *
 * The API key rides the secrets seam (see
 * https://alchemy.run/environments/secrets/): `Config.redacted` is
 * evaluated while the org layer builds during INIT, so the deploy
 * discovers it and binds it onto the Worker as a `secret_text`. At
 * runtime the same `Config` resolves from that binding — the key
 * never appears in the bundle.
 */
import * as Cloudflare from "@/Cloudflare/index.ts";
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MinimumLogLevel } from "effect/References";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { LoggingObserver, Scribe, ScribeLive } from "./DriverAgents.ts";

const Anthropic = AnthropicLanguageModel.layer({
  model: "claude-haiku-4-5",
}).pipe(
  Layer.provide(
    AnthropicClient.layerConfig({
      apiKey: Config.redacted("ANTHROPIC_API_KEY"),
    }),
  ),
  Layer.provide(FetchHttpClient.layer),
);

const Agents = ScribeLive.pipe(
  Layer.provideMerge(Cloudflare.AI.DriverCloudflare),
  Layer.provideMerge(
    Layer.mergeAll(
      Anthropic,
      LoggingObserver,
      Layer.succeed(MinimumLogLevel, "Debug"),
    ),
  ),
);

export default class KernelAnthropicTestWorker extends Cloudflare.Worker<KernelAnthropicTestWorker>()(
  "KernelAnthropicTestWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const scribe = yield* Scribe;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://worker");

        if (url.pathname === "/dispatch") {
          const key = url.searchParams.get("key") ?? "default";
          const input = url.searchParams.get("input") ?? "hello";
          const answer = yield* scribe.dispatch(input, { key });
          return yield* HttpServerResponse.json({ answer });
        }

        return HttpServerResponse.text("ok");
      }),
    };
  }).pipe(Effect.provide(Agents)),
) {}
