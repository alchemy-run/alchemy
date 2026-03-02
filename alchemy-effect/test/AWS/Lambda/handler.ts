import * as Lambda from "@/AWS/Lambda";
import { Http } from "@/index";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export default Effect.gen(function* () {
  yield* Http.serve(
    Effect.gen(function* () {
      return HttpServerResponse.text("Hello, world!");
    }),
  );

  return {
    main,
  } as const;
}).pipe(Effect.provide(Http.lambdaHttpServer), Lambda.Function("TestFunction"));
