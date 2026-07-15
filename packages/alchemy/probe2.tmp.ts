import { fromChain } from "@distilled.cloud/aws/Credentials";
import { Region } from "@distilled.cloud/aws/Region";
import * as lexm from "@distilled.cloud/aws/lex-models-v2";
import * as lexr from "@distilled.cloud/aws/lex-runtime-v2";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { layer as fetchLayer } from "effect/unstable/http/FetchHttpClient";

const main = Effect.gen(function* () {
  const bots = yield* Effect.result(lexm.listBots({}));
  console.log("listBots: ", JSON.stringify(bots).slice(0, 200));
  const del = yield* Effect.result(
    lexr.deleteSession({
      botId: "BOGUSBOT01",
      botAliasId: "TSTALIASID",
      localeId: "en_US",
      sessionId: "probe-1",
    }),
  );
  console.log("deleteSession:", JSON.stringify(del).slice(0, 300));
  const text = yield* Effect.result(
    lexr.recognizeText({
      botId: "BOGUSBOT01",
      botAliasId: "TSTALIASID",
      localeId: "en_US",
      sessionId: "probe-1",
      text: "hello",
    }),
  );
  console.log("recognizeText:", JSON.stringify(text).slice(0, 300));
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
