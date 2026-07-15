import * as bda from "@distilled.cloud/aws/bedrock-data-automation";
import { fromChain } from "@distilled.cloud/aws/Credentials";
import { fromEnv as regionFromEnv } from "@distilled.cloud/aws/Region";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

const arn =
  "arn:aws:bedrock:us-west-2:391965393224:data-automation-library/564476923b70";

const program = Effect.gen(function* () {
  const del = yield* Effect.result(
    bda.deleteDataAutomationLibrary({ libraryArn: arn }),
  );
  console.log(
    "delete:",
    Result.isSuccess(del)
      ? JSON.stringify(del.success)
      : JSON.stringify(del.failure),
  );
  const got = yield* Effect.result(
    bda.getDataAutomationLibrary({ libraryArn: arn }),
  );
  console.log(
    "get after delete:",
    Result.isSuccess(got)
      ? JSON.stringify(got.success)
      : JSON.stringify(got.failure),
  );
}).pipe(
  Effect.provide(
    Layer.mergeAll(fromChain(), regionFromEnv(), FetchHttpClient.layer),
  ),
);

await Effect.runPromise(program as Effect.Effect<void, never, never>).catch(
  (e) => {
    console.error("DIED:", e);
    process.exit(1);
  },
);
