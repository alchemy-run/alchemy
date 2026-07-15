// Probe the real error tags for copy/restore on a nonexistent snapshot ARN.
import * as Credentials from "@distilled.cloud/aws/Credentials";
import * as docdbelastic from "@distilled.cloud/aws/docdb-elastic";
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

const show = (label: string, r: Result.Result<unknown, unknown>) => {
  if (Result.isSuccess(r)) {
    console.log(label, "OK", JSON.stringify(r.success).slice(0, 300));
  } else {
    console.log(label, "ERR", JSON.stringify(r.failure).slice(0, 800));
  }
};

const main = Effect.gen(function* () {
  const snapArn =
    "arn:aws:docdb-elastic:us-west-2:391965393224:cluster-snapshot/00000000-0000-0000-0000-000000000000";

  show(
    "copyClusterSnapshot(bogus)",
    yield* Effect.result(
      docdbelastic.copyClusterSnapshot({
        snapshotArn: snapArn,
        targetSnapshotName: "alchemy-docdb-elastic-copy-probe",
      }),
    ),
  );
  show(
    "restoreClusterFromSnapshot(bogus)",
    yield* Effect.result(
      docdbelastic.restoreClusterFromSnapshot({
        snapshotArn: snapArn,
        clusterName: "alchemy-docdb-elastic-restore-probe",
      }),
    ),
  );
});

await Effect.runPromise(main.pipe(Effect.provide(runtime)));
