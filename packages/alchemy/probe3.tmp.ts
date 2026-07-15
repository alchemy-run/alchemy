import { fromChain } from "@distilled.cloud/aws/Credentials";
import { Region } from "@distilled.cloud/aws/Region";
import * as lexr from "@distilled.cloud/aws/lex-runtime-v2";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { layer as fetchLayer } from "effect/unstable/http/FetchHttpClient";

const text = (label: string) =>
  Effect.gen(function* () {
    const r = yield* Effect.result(
      lexr.recognizeText({
        botId: "BOGUSBOT01",
        botAliasId: "TSTALIASID",
        localeId: "en_US",
        sessionId: "probe-1",
        text: "hello",
      }),
    );
    console.log(label, JSON.stringify(r).slice(0, 160));
  });

const utter = (label: string, responseContentType?: string) =>
  Effect.gen(function* () {
    const r = yield* Effect.result(
      lexr.recognizeUtterance({
        botId: "BOGUSBOT01",
        botAliasId: "TSTALIASID",
        localeId: "en_US",
        sessionId: "probe-1",
        requestContentType: "text/plain; charset=utf-8",
        ...(responseContentType ? { responseContentType } : {}),
        inputStream: new TextEncoder().encode("hello"),
      }),
    );
    console.log(label, JSON.stringify(r).slice(0, 200));
  });

const main = Effect.gen(function* () {
  yield* text("text#1:  ");
  yield* utter("utter#1: ", "text/plain; charset=utf-8");
  yield* text("text#2:  ");
  yield* utter("utter#2 (no responseContentType):");
  yield* utter("utter#3 (simple ct): ");
});

Effect.runPromise(
  main.pipe(
    Effect.provide(
      Layer.mergeAll(
        fromChain(),
        Layer.succeed(Region, Effect.succeed("us-east-1")),
        fetchLayer,
      ),
    ),
  ) as Effect.Effect<void>,
).catch((e) => {
  console.error(String(e).slice(0, 500));
  process.exit(1);
});
