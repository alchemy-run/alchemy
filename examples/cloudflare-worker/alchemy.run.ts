import alchemy, { type } from "alchemy";
import {
  Container,
  DOStateStore,
  Queue,
  Worker,
  WranglerJson,
} from "alchemy/cloudflare";
import { Image } from "alchemy/docker";
import type MyRPC from "./src/rpc.ts";

const BRANCH_PREFIX = process.env.BRANCH_PREFIX ?? "";
const app = await alchemy("cloudflare-worker", {
  stage: BRANCH_PREFIX || undefined,
  stateStore:
    process.env.ALCHEMY_STATE_STORE === "cloudflare"
      ? (scope) => new DOStateStore(scope)
      : undefined,
});

export const queue = await Queue<{
  name: string;
  email: string;
}>(`cloudflare-worker-queue${BRANCH_PREFIX}`, {
  name: `cloudflare-worker-queue${BRANCH_PREFIX}`,
  adopt: true,
});

export const rpc = await Worker(`cloudflare-worker-rpc${BRANCH_PREFIX}`, {
  entrypoint: "./src/rpc.ts",
  rpc: type<MyRPC>,
});

export const worker = await Worker("worker", {
  entrypoint: "./src/worker.ts",
  bindings: {
    MY_CONTAINER: new Container("test-container", {
      className: "MyContainer",
      image: await Image("test-image", {
        dockerfile: "Dockerfile",
      }),
    }),
  },
});

import { env } from "cloudflare:workers";

env.MY_CONTAINER.await;
WranglerJson("wrangler.jsonc", {
  worker,
});

console.log(worker.url);

await app.finalize();
