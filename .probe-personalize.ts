import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/unstable/http";
import { fromChain } from "/Users/samgoodwin/workspaces/alchemy-effect/.claude/worktrees/r2-bucket-cors-v2-a32892/distilled/packages/aws/src/credentials.ts";
import { Region } from "/Users/samgoodwin/workspaces/alchemy-effect/.claude/worktrees/r2-bucket-cors-v2-a32892/distilled/packages/aws/src/region.ts";
import * as personalize from "/Users/samgoodwin/workspaces/alchemy-effect/.claude/worktrees/r2-bucket-cors-v2-a32892/distilled/packages/aws/src/services/personalize.ts";

const main = Effect.gen(function* () {
  const groups = yield* personalize.listDatasetGroups.pages({}).pipe(Stream.runCollect);
  const groupList = Array.from(groups).flatMap((p) => p.datasetGroups ?? []);
  for (const g of groupList) {
    console.log("GROUP", g.name, g.status, g.datasetGroupArn);
    const datasets = yield* personalize
      .listDatasets({ datasetGroupArn: g.datasetGroupArn })
      .pipe(Effect.catch((e) => Effect.sync(() => { console.log("  listDatasets error", (e as any)._tag); return {} as any; })));
    for (const d of datasets.datasets ?? []) console.log("  DATASET", d.name, d.status, d.datasetArn);
    const trackers = yield* personalize
      .listEventTrackers({ datasetGroupArn: g.datasetGroupArn })
      .pipe(Effect.catch(() => Effect.succeed({} as any)));
    for (const t of trackers.eventTrackers ?? []) console.log("  TRACKER", t.name, t.status, t.eventTrackerArn);
    const solutions = yield* personalize
      .listSolutions({ datasetGroupArn: g.datasetGroupArn })
      .pipe(Effect.catch(() => Effect.succeed({} as any)));
    for (const s of solutions.solutions ?? []) console.log("  SOLUTION", s.name, s.status, s.solutionArn);
  }
  const schemas = yield* personalize.listSchemas.pages({}).pipe(Stream.runCollect);
  for (const s of Array.from(schemas).flatMap((p) => p.schemas ?? []))
    console.log("SCHEMA", s.name, s.domain ?? "-", s.schemaArn);
});

const layers = Layer.mergeAll(
  fromChain(),
  Layer.succeed(Region, Effect.succeed((process.env.AWS_REGION ?? "us-west-2") as any)),
  FetchHttpClient.layer,
);

await Effect.runPromise(main.pipe(Effect.provide(layers)) as any);
