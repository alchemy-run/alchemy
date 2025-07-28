/// <reference types="@types/node" />

import alchemy from "alchemy";
import { D1Database, DurableObjectNamespace, Vite } from "alchemy/cloudflare";

const app = await alchemy("cloudflare-livestore");

const db = await D1Database("db", {
  name: `${app.name}-${app.stage}-livestore`,
  adopt: true,
});

export const server = await Vite("server", {
  assets: "dist",
  main: "src/livestore/server.ts",
  wrangler: false,
  compatibility: "node",
  bindings: {
    DB: db,
    WEBSOCKET_SERVER: DurableObjectNamespace("websocket-server", {
      className: "WebSocketServer",
    }),
  },
});

console.log(`server.url: ${server.url}`);

await app.finalize();
