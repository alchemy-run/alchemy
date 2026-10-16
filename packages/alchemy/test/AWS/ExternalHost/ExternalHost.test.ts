import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as AWS from "@/AWS";
import { makeWorkerRuntimeContext } from "@/Cloudflare/Workers/WorkerRuntimeContext.ts";
import * as Alchemy from "@/index.ts";
import * as Provider from "@/Provider.ts";
import { RuntimeContext } from "@/RuntimeContext.ts";
import { Self } from "@/Self.ts";

// Regression for #2306: a plan/deploy re-runs a host's init with a fresh
// `RuntimeContext` while `stack.resources` returns the same host object. The
// external AWS identity was cached per host, so every pass after the first
// skipped registering the access key, role ARN and region on the new
// `RuntimeContext` and the Worker deployed without them.

// Providers are never called: this only exercises declaration/registration.
const unused = {
  list: () => Effect.die("unused"),
  reconcile: () => Effect.die("unused"),
  delete: () => Effect.die("unused"),
};
const providers = Layer.effect(
  AWS.Providers,
  Provider.collection([AWS.IAM.User, AWS.IAM.AccessKey, AWS.IAM.Role, AWS.S3.Bucket]),
).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      Provider.succeed(AWS.IAM.User, unused),
      Provider.succeed(AWS.IAM.AccessKey, unused),
      Provider.succeed(AWS.IAM.Role, unused),
      Provider.succeed(AWS.S3.Bucket, unused),
      FetchHttpClient.layer,
    ),
  ),
);

// What a Worker's init does with an S3 binding.
const init = Effect.gen(function* () {
  const bucket = yield* AWS.S3.Bucket("Bucket", {});
  yield* AWS.S3.GetObject(bucket);
}).pipe(Effect.provide(AWS.S3.GetObjectHttp));

describe("AWS external host", { tags: ["unit", "provider:aws", "local"] }, () => {
  it("registers the credential env on every init pass of the same host", async () => {
    const stack = { name: "repro", stage: "test", resources: {}, bindings: {}, actions: {} };
    const host = { Type: "Cloudflare.Worker", LogicalId: "Api", FQN: "Api" };
    const envKeys: string[][] = [];

    await Effect.gen(function* () {
      for (let pass = 0; pass < 2; pass++) {
        const runtime = makeWorkerRuntimeContext("Api");
        yield* init.pipe(
          Effect.provideService(Alchemy.Stack, stack as any),
          Effect.provideService(RuntimeContext, runtime),
          Effect.provideService(Self, host as any),
          Effect.provide(providers),
        );
        envKeys.push(
          Object.keys(runtime.env)
            .filter((key) => key.startsWith("Api") || key === "ALCHEMY_AWS_REGION")
            .sort(),
        );
      }
    }).pipe(Effect.scoped, Effect.runPromise);

    expect(envKeys[0]).toEqual([
      "ALCHEMY_AWS_REGION",
      "ApiAccessKey_accessKeyId",
      "ApiAccessKey_secretAccessKey",
      "ApiRole_roleArn",
    ]);
    expect(envKeys[1]).toEqual(envKeys[0]);
  });
});
