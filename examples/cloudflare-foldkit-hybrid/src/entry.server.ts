import { Effect } from "effect";
import { Server } from "foldkit/experimental";

import { Flags, init, view } from "./main";

export const prerenderPaths: ReadonlyArray<string> = ["/", "/about"];

export const renderPage = (request: Request): Promise<Server.EntryResult> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const url = new URL(request.url);
      const pathname = url.pathname.replace(/\/+$/, "") || "/";
      if (!prerenderPaths.includes(pathname) && pathname !== "/counter") {
        return Server.Responded(new Response("Not Found", { status: 404 }));
      }
      const count = Number(url.searchParams.get("count") ?? 0);
      const renderedApplication = yield* Server.renderToString(
        { routing: {}, Flags, init, view },
        {
          url: request.url,
          flags: { initialCount: Number.isSafeInteger(count) ? count : 0 },
        },
      );

      return pathname === "/counter"
        ? Server.Rendered(renderedApplication, {
            headers: { "cache-control": "private, no-store" },
          })
        : Server.Rendered(renderedApplication);
    }),
  );
