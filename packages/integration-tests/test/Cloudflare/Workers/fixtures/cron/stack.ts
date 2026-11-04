import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import CronTestWorker from "./cron-worker.ts";
import ShapeCronWorkerLive, { ShapeCronWorker } from "./shape-worker.ts";

export default Alchemy.Stack(
  "CronEventSourceStack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* CronTestWorker;
    const shapeWorker = yield* ShapeCronWorker.pipe(Effect.provide(ShapeCronWorkerLive));
    return {
      workerName: worker.workerName,
      url: worker.url.as<string>(),
      crons: worker.crons,
      shapeWorkerName: shapeWorker.workerName,
      shapeUrl: shapeWorker.url.as<string>(),
      shapeCrons: shapeWorker.crons,
    };
  }),
);
