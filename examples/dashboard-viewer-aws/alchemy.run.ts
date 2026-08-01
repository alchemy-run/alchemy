import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";

import ViewerFunction from "./src/viewer-function.ts";

const dashboardDist =
  process.env.ALCHEMY_DASHBOARD_DIST ?? "../../packages/dashboard/dist";

export default Alchemy.Stack(
  "DashboardViewerAws",
  {
    providers: AWS.providers(),
    state: AWS.state(),
  },
  Effect.gen(function* () {
    const fn = yield* ViewerFunction;

    // One CloudFront distribution: `/api/*` to the viewer Lambda, every
    // other path to the SPA assets — same-origin, exactly like the
    // Cloudflare variant.
    const router = yield* AWS.Website.Router("ViewerRouter", {
      routes: {
        "/api/*": { url: fn.functionUrl.as<string>() },
      },
    });

    yield* AWS.Website.StaticSite("DashboardSite", {
      path: dashboardDist,
      router: { instance: router },
    });

    return {
      url: router.url.as<string>(),
    };
  }),
);
