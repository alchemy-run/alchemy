import type { AstroIntegration } from "astro";
import { referenceDestination } from "../src/reference-links";

/** Match the deployed Worker's legacy reference routes in the dev server. */
export function referenceRedirects(): AstroIntegration {
  return {
    name: "reference-redirects",
    hooks: {
      "astro:server:setup": ({ server }) => {
        server.middlewares.use((request, response, next) => {
          const target = request.url && referenceDestination(request.url);
          if (!target) return next();
          response.writeHead(302, { Location: target });
          response.end();
        });
      },
    },
  };
}
