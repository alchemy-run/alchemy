import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * The "web app" side: an HTML page served from its own subdomain that
 * calls the API on a sibling subdomain from the browser (`fetch` with
 * credentials), so a real browser exercises CORS + cookies across the two
 * dev origins. `?api=<url>` tells the page where the API lives.
 */
export default class IngressWebWorker extends Cloudflare.Worker<IngressWebWorker>()(
  "IngressWeb",
  {
    main: import.meta.url,
    dev: { subdomain: "web" },
  },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        // Effect's request URL is path-only (`/echo?x=1`); anchor it.
        const url = new URL(request.url, "http://localhost");
        if (url.pathname === "/whoami") {
          return yield* HttpServerResponse.json({ url: request.url });
        }
        const api = url.searchParams.get("api") ?? "";
        return HttpServerResponse.html(`<!doctype html>
<html><head><meta charset="utf-8"><title>ingress web</title></head>
<body>
<h1>web</h1>
<pre id="out">loading…</pre>
<script type="module">
  const api = ${JSON.stringify(api)};
  const out = document.getElementById("out");
  try {
    const cookie = await fetch(api + "/cookie", { credentials: "include" });
    const echo = await fetch(api + "/echo", {
      credentials: "include",
      headers: { "content-type": "application/json" },
    });
    out.textContent = JSON.stringify({
      cookieStatus: cookie.status,
      echoStatus: echo.status,
      echo: await echo.json(),
    });
    out.dataset.state = "done";
  } catch (error) {
    out.textContent = "error: " + (error && error.message);
    out.dataset.state = "error";
  }
</script>
</body></html>`);
      }),
    };
  }),
) {}
