import alchemy from "alchemy";
import { DurableObjectNamespace, Vite, Worker } from "alchemy/cloudflare";
import type { WebSocketServer } from "./src/server.ts";

const app = await alchemy("cloudflare-durable-object-websocket");

export const server = await Worker("server", {
  name: `${app.name}-${app.stage}-server`,
  entrypoint: "src/server.ts",
  bindings: {
    WS_SERVER: DurableObjectNamespace<WebSocketServer>("ws-server", {
      className: "WebSocketServer",
      sqlite: true,
    }),
  },
});

export const client = await Vite("client", {
  name: `${app.name}-${app.stage}-client`,
  assets: "dist",
  env: {
    VITE_WEBSOCKET_URL: server.url!,
  },
  wrangler: false,
});

console.log("Client:", client.url);

await app.finalize();
