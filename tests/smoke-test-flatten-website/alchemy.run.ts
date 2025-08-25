/// <reference types="@types/node" />

import alchemy from "alchemy";
import {
  DurableObjectNamespace,
  Queue,
  R2Bucket,
  Vite,
  Workflow,
} from "alchemy/cloudflare";
import assert from "node:assert";
import type { HelloWorldDO } from "./src/do.ts";

const app = await alchemy("smoke-test-flatten-website");

export const queue = await Queue<{
  name: string;
  email: string;
}>("queue", {
  name: `${app.name}-${app.stage}-queue`,
  adopt: true,
});

export const worker = await Vite("worker", {
  name: `${app.name}-${app.stage}-worker`,
  entrypoint: "./src/worker.ts",
  bindings: {
    BUCKET: await R2Bucket("bucket", {
      name: `${app.name}-${app.stage}-bucket`,
      adopt: true,
    }),
    QUEUE: queue,
    WORKFLOW: Workflow("OFACWorkflow", {
      className: "OFACWorkflow",
      workflowName: "ofac-workflow",
    }),
    DO: DurableObjectNamespace<HelloWorldDO>("HelloWorldDO", {
      className: "HelloWorldDO",
      // sqlite: true,
    }),
  },
  url: true,
  eventSources: [queue],
  bundle: {
    metafile: true,
    format: "esm",
    target: "es2020",
  },
  adopt: true,
});

console.log(worker.url);

await app.finalize();

if ("RUN_COUNT" in process.env) {
  const RUN_COUNT = Number(process.env.RUN_COUNT);

  const { count } = await (await fetch(worker.url + "/increment")).json() as { count: number };

  console.log("count", count);
  console.log("RUN_COUNT", RUN_COUNT);
  assert(count === RUN_COUNT, `Count is not equal to RUN_COUNT: ${count} !== ${RUN_COUNT}`);

  console.log("test passed");
} 
