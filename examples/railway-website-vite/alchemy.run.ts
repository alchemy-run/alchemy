import * as Alchemy from "alchemy";
import * as Railway from "alchemy/Railway";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

const RAILWAY_REGISTRY = Config.string("RAILWAY_REGISTRY").pipe(
  Config.option,
  Config.map(Option.getOrUndefined),
);

const RAILWAY_TEST_DOMAIN = Config.string("RAILWAY_TEST_DOMAIN").pipe(
  Config.option,
  Config.map(Option.getOrUndefined),
);

export default Alchemy.Stack(
  "RailwayWebsiteViteExample",
  {
    providers: Railway.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const registry = yield* RAILWAY_REGISTRY;
    const domain = yield* RAILWAY_TEST_DOMAIN;

    // `alchemy deploy` runs `vite build` and serves `dist/` from one
    // Railway.Service. `alchemy dev` is Vite's own dev server (HMR
    // included) and creates no cloud resources. `registry` is required
    // on the live path (GHCR / Docker Hub prefix Railway can pull).
    const site = yield* Railway.Website.Vite("Web", {
      registry,
      domain,
      memo: {
        include: [
          "index.html",
          "src/**",
          "public/**",
          "package.json",
          "vite.config.ts",
        ],
      },
    });

    return {
      url: site.url,
      serviceId: site.service?.serviceId,
    };
  }),
);
