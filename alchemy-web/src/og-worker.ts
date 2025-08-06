import { ImageResponse } from "workers-og";
import type { website } from "../alchemy.run.ts";

export default {
  async fetch(request: Request, env: typeof website.Env): Promise<Response> {
    const url = new URL(request.url);

    // Static dimensions
    const width = 1200;
    const height = 630;

    // Extract the path from the URL (everything after the domain)
    if (url.pathname.endsWith(".png")) {
      // Make request to alchemy.run/og/... with the same path to get HTML
      const ogHtmlUrl = `https://${url.hostname}/og${url.pathname.substring(0, url.pathname.length - ".png".length)}`;

      const response = await env.ASSETS.fetch(ogHtmlUrl);

      if (!response.ok) {
        return new Response(
          JSON.stringify({
            notFound: ogHtmlUrl,
          }),
          { status: 404 },
        );
      }

      return new ImageResponse(response.body, {
        width,
        height,
        format: "png",
      });
    } else {
      return new Response("Not Found", { status: 404 });
    }
  },
};
