import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { Session, Unauthorized } from "./auth.ts";
/** The application's own API. Git routes are composed beside it in git.ts. */
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import { AppRoutes } from "./routes.ts";

export class AppApi extends HttpApi.make("app").add(AppRoutes) {}

const MeLive = HttpApiBuilder.group(AppApi, "app", (h) =>
  h.handle("me", () =>
    Effect.gen(function* () {
      const { user } = yield* Session;
      if (user === null) return yield* new Unauthorized();
      return user;
    }),
  ),
);

export const AppApiLive = HttpApiBuilder.layer(AppApi).pipe(
  Layer.provide(MeLive),
);
