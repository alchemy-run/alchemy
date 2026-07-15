import { fromChain } from "@distilled.cloud/aws/Credentials";
import { Region } from "@distilled.cloud/aws/Region";
import * as lexr from "@distilled.cloud/aws/lex-runtime-v2";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { layer as fetchLayer } from "effect/unstable/http/FetchHttpClient";

const main = Effect.gen(function* () {
  const result = yield* Effect.result(
    lexr.recognizeUtterance({
      botId: "BOGUSBOT01",
      botAliasId: "TSTALIASID",
      localeId: "en_US",
      sessionId: "probe-1",
      requestContentType: "text/plain; charset=utf-8",
      responseContentType: "text/plain; charset=utf-8",
      inputStream: new TextEncoder().encode("hello"),
    }),
  );
  console.log("utterance:", JSON.stringify(result).slice(0, 600));

  const result2 = yield* Effect.result(
    lexr.recognizeText({
      botId: "BOGUSBOT01",
      botAliasId: "TSTALIASID",
      localeId: "en_US",
      sessionId: "probe-1",
      text: "hello",
    }),
  );
  console.log("text:     ", JSON.stringify(result2).slice(0, 600));
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
  console.error(String(e).slice(0, 1000));
  process.exit(1);
});
