import alchemy from "alchemy";
import { Worker, WorkerLoader } from "alchemy/cloudflare";

const app = await alchemy("cloudflare-worker-loader");

export const loader = WorkerLoader();

export const worker = await Worker("worker", {
  entrypoint: "./src/worker.ts",
  bindings: {
    LOADER: loader,
  },
  url: true,
});

console.log(`Worker URL: ${worker.url}`);

await app.finalize();
