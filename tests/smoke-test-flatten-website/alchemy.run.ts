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
      empty: true
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
  const { count } = await fetchJson<{ count: number }>("GET", "/increment");
  assert(count === RUN_COUNT, `Count is not equal to RUN_COUNT: ${count} !== ${RUN_COUNT}`);
  if (RUN_COUNT === 0) {
    // on first run, the key should be null
    const { key } = await fetchJson<{ key: string | null }>("GET", "/object");
    assert(key === null, `${key} !== null`);
    await fetchJson<{ key: string | null }>("POST", "/object");
  } else {
    // on second run the data should still be there
    const { key } = await fetchJson<{ key: string | null }>("GET", "/object");
    assert(key === "value", `${key} !== "value"`);
  }
  console.log("test passed");
}

async function fetchJson<T>(method: "GET" | "POST", path: string): Promise<T> {
  const response = await fetch(worker.url + path, {
    method,
  });
  if (response.status === 404) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    // sometimes propagation is not immediate, so we retry
    return fetchJson<T>(method, path);
  }
  if (!response.ok) {
    throw new Error(`Failed to fetch ${path}: ${response.statusText}`);
  }
  return await response.json() as T;
}