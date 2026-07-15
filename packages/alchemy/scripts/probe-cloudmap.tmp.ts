import * as Credentials from "@distilled.cloud/aws/Credentials";
import { Region } from "@distilled.cloud/aws/Region";
import * as sd from "@distilled.cloud/aws/servicediscovery";
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
  // all namespaces, unfiltered
  const all = yield* Effect.result(sd.listNamespaces({}));
  if (Result.isSuccess(all)) {
    for (const ns of all.success.Namespaces ?? []) {
      console.log("namespace:", ns.Id, ns.Type, ns.Name);
    }
  } else {
    console.log("listNamespaces failed:", JSON.stringify(all.failure));
  }
  // exact-name filtered lookup, as observeNamespace does
  const filtered = yield* Effect.result(
    sd.listNamespaces({
      Filters: [
        { Name: "TYPE", Values: ["HTTP"], Condition: "EQ" },
        {
          Name: "NAME",
          Values: ["alchemy-test-cloudmap-http-b"],
          Condition: "EQ",
        },
      ],
    }),
  );
  console.log(
    "filtered lookup:",
    Result.isSuccess(filtered)
      ? JSON.stringify(filtered.success.Namespaces ?? [])
      : JSON.stringify(filtered.failure),
  );
  // pending operations
  const ops = yield* Effect.result(
    sd.listOperations({
      Filters: [
        { Name: "STATUS", Values: ["SUBMITTED", "PENDING"], Condition: "IN" },
      ],
    }),
  );
  console.log(
    "pending ops:",
    Result.isSuccess(ops)
      ? JSON.stringify(ops.success.Operations ?? [])
      : JSON.stringify(ops.failure),
  );
});

await Effect.runPromise(main.pipe(Effect.provide(runtime)));
