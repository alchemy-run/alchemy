import * as bda from "@distilled.cloud/aws/bedrock-data-automation";
import { fromChain } from "@distilled.cloud/aws/Credentials";
import { fromEnv as regionFromEnv } from "@distilled.cloud/aws/Region";
import * as sts from "@distilled.cloud/aws/sts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

const program = Effect.gen(function* () {
  const id = yield* sts.getCallerIdentity({});
  console.log("account:", id.Account, "region:", process.env.AWS_REGION);

  const libs = yield* Effect.result(bda.listDataAutomationLibraries({}));
  if (Result.isSuccess(libs)) {
    console.log(
      "listDataAutomationLibraries OK:",
      JSON.stringify(libs.success),
    );
  } else {
    console.log(
      "listDataAutomationLibraries FAIL:",
      JSON.stringify(libs.failure, null, 2),
    );
  }

  // create + get + update + delete lifecycle probe
  const created = yield* Effect.result(
    bda.createDataAutomationLibrary({ libraryName: "alchemy-probe-lib" }),
  );
  if (Result.isSuccess(created)) {
    console.log("createDataAutomationLibrary OK:", { ...created.success });
    const arn = created.success.libraryArn!;
    const got = yield* Effect.result(
      bda.getDataAutomationLibrary({ libraryArn: arn }),
    );
    console.log(
      "getDataAutomationLibrary:",
      Result.isSuccess(got)
        ? JSON.stringify({ ...got.success.library })
        : JSON.stringify(got.failure),
    );
    const del = yield* Effect.result(
      bda.deleteDataAutomationLibrary({ libraryArn: arn }),
    );
    console.log(
      "deleteDataAutomationLibrary:",
      Result.isSuccess(del)
        ? JSON.stringify({ ...del.success })
        : JSON.stringify(del.failure),
    );
  } else {
    console.log(
      "createDataAutomationLibrary FAIL:",
      JSON.stringify(created.failure, null, 2),
    );
  }

  // blueprint optimization status probe with a bogus invocation id
  const opt = yield* Effect.result(
    bda.getBlueprintOptimizationStatus({
      invocationArn: `arn:aws:bedrock:us-west-2:${id.Account}:blueprint-optimization-invocation/00000000-0000-0000-0000-000000000000`,
    }),
  );
  console.log(
    "getBlueprintOptimizationStatus:",
    Result.isSuccess(opt)
      ? JSON.stringify({ ...opt.success })
      : JSON.stringify(opt.failure, null, 2),
  );

  // library entity list probe with a bogus library arn shape
  const ents = yield* Effect.result(
    bda.listDataAutomationLibraryEntities({
      libraryArn: `arn:aws:bedrock:us-west-2:${id.Account}:data-automation-library/nonexistent`,
      entityType: "VOCABULARY",
    }),
  );
  console.log(
    "listDataAutomationLibraryEntities:",
    Result.isSuccess(ents)
      ? JSON.stringify({ ...ents.success })
      : JSON.stringify(ents.failure, null, 2),
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
