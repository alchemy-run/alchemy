import * as Alchemy from "alchemy";
import * as Fly from "alchemy/Fly";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "FlyWebsiteViteExample",
  {
    providers: Fly.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    // `alchemy deploy` runs `vite build` and serves the output from a Fly
    // Machine; `alchemy dev` runs Vite's own dev server (HMR included) and
    // the site's url is the local server — no Fly App or Service is created.
    const site = yield* Fly.Website.Vite("Web", {
      memo: {
        include: ["index.html", "src/**", "package.json", "vite.config.ts"],
      },
    });

    return {
      url: site.url,
      appName: site.app?.appName,
    };
  }),
);
