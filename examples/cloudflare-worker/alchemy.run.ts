import alchemy from "../../alchemy/src";
import {
  Queue,
  R2Bucket,
  Worker,
  WranglerJson,
} from "../../alchemy/src/cloudflare";

const BRANCH_PREFIX = process.env.BRANCH_PREFIX ?? "";
const app = await alchemy("cloudflare-worker", {
  phase: process.argv.includes("--destroy") ? "destroy" : "up",
});

export const queue = await Queue<{
  name: string;
  email: string;
}>(`cloudflare-worker-queue${BRANCH_PREFIX}`);

export const worker = await Worker(`cloudflare-worker-worker${BRANCH_PREFIX}`, {
  entrypoint: "./src/worker.ts",
  bindings: {
    BUCKET: await R2Bucket(`cloudflare-worker-bucket${BRANCH_PREFIX}`, {
      // so that CI is idempotent
      adopt: true,
    }),
    QUEUE: queue,
  },
  // eventSources: [queue],
});

await WranglerJson("wrangler.jsonc", {
  worker,
});

await app.finalize();
