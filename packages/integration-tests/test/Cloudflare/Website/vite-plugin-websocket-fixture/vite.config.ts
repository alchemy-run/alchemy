// A Vite plugin that serves its own WebSocket on the dev server, as
// `@foldkit/vite-plugin` serves its DevTools relay (#2191). The Worker has
// no route for the path, so the dev server must leave the socket to the
// plugin.
import type { Plugin } from "vite";
import { WebSocketServer } from "ws";

const echoPlugin: Plugin = {
  name: "ws-echo",
  configureServer(server) {
    const wss = new WebSocketServer({ noServer: true });
    server.httpServer?.on("upgrade", (request, socket, head) => {
      if (request.url !== "/__echo") return;
      wss.handleUpgrade(request, socket, head, (ws) => {
        ws.on("message", (data) => ws.send(`echo ${data}`));
      });
    });
  },
};

export default { plugins: [echoPlugin] };
