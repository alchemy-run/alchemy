import "../../alchemy/src/cloudflare";

import alchemy from "../../alchemy/src";
import {
  Queue,
  R2Bucket,
  Worker,
  WranglerJson,
} from "../../alchemy/src/cloudflare";

const app = await alchemy("worker-app");

export const queue = await Queue<{
  name: string;
  email: string;
}>("example-worker-queue");

export const worker = await Worker("example-worker", {
  entrypoint: "./src/worker.ts",
  bindings: {
    BUCKET: await R2Bucket("example-worker-bucket"),
    QUEUE: queue,
  },
  eventSources: [queue],
});

await WranglerJson("wrangler.jsonc", {
  worker,
});

await app.finalize();
