import { Effect } from "effect";
import { Server } from "foldkit/experimental";

import { init, view } from "./main";

export const prerenderPaths: ReadonlyArray<string> = ["/", "/about"];

export const renderPage = (request: Request): Promise<Server.EntryResult> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const pathname = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
      if (!prerenderPaths.includes(pathname)) {
        return Server.Responded(new Response("Not Found", { status: 404 }));
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        return Server.Responded(
          new Response(null, { status: 405, headers: { allow: "GET, HEAD" } }),
        );
      }
      const renderedApplication = yield* Server.renderToString(
        { routing: {}, init, view },
        { url: request.url },
      );

      return Server.Rendered(renderedApplication);
    }),
  );
