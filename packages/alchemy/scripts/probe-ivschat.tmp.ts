// Probe the exact error CreateRoom raises for an invalid messageReviewHandler.
import * as Credentials from "@distilled.cloud/aws/Credentials";
import * as ivschat from "@distilled.cloud/aws/ivschat";
import { Region } from "@distilled.cloud/aws/Region";
import { NodeServices } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

const runtime = Layer.mergeAll(
  NodeServices.layer,
  FetchHttpClient.layer,
  Credentials.fromChain(),
  Layer.succeed(Region, "us-west-2"),
);

const main = Effect.gen(function* () {
  const result = yield* Effect.result(
    ivschat.createRoom({
      name: "alchemy-probe-invalid-handler",
      messageReviewHandler: {
        uri: "arn:aws:lambda:us-west-2:123456789012:function:does-not-exist",
        fallbackResult: "ALLOW",
      },
    }),
  );
  if (Result.isFailure(result)) {
    const e = result.failure as any;
    console.log("tag:", e?._tag);
    console.log("ctor:", e?.constructor?.name);
    console.log(
      "instanceof ValidationException:",
      e instanceof ivschat.ValidationException,
    );
    console.log("message:", e?.message);
    console.log("reason:", e?.reason);
    console.log("json:", JSON.stringify(e)?.slice(0, 1500));
  } else {
    console.log("unexpectedly succeeded:", JSON.stringify(result.success));
    const arn = (result.success as any).arn;
    if (arn) yield* ivschat.deleteRoom({ identifier: arn });
  }
});

await Effect.runPromise(main.pipe(Effect.provide(runtime)) as any);
