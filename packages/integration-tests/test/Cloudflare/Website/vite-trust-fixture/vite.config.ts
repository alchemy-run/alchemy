import { readFileSync } from "node:fs";
import type { ViteDevServer } from "vite";

// Reports the trust the dev server's own Node process started with.
export default {
  plugins: [
    {
      name: "node-trust",
      configureServer(server: ViteDevServer) {
        server.middlewares.use("/__node-trust", (_request, response) => {
          const bundle = process.env.NODE_EXTRA_CA_CERTS;
          response.setHeader("content-type", "application/json");
          response.end(
            JSON.stringify({
              bundle,
              certificates: bundle ? readFileSync(bundle, "utf8") : undefined,
            }),
          );
        });
      },
    },
  ],
};
