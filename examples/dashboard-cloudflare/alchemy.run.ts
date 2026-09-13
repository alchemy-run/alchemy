import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Dashboard } from "alchemy/Dashboard/Hosted/Cloudflare";
import * as Effect from "effect/Effect";

// A hosted alchemy dashboard: one Worker serving the dashboard SPA and the
// read-only viewer API over the same Cloudflare state store this stack (and
// every other stack deployed from this profile) uses.
export default Alchemy.Stack(
  "DashboardCloudflare",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const dashboard = yield* Dashboard({
      // The dashboard shows everything in the state store — gate it. Use
      // Cloudflare Access policies for a team, or `"public"` to opt out.
      access: {
        policies: [
          { decision: "allow", include: [{ emailDomain: "example.com" }] },
        ],
      },
    });
    return {
      url: dashboard.url.as<string>(),
    };
  }),
);
