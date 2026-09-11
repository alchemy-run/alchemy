import * as Alchemy from "alchemy";
import * as Fly from "alchemy/Fly";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "FlyWebsiteVinextExample",
  {
    providers: Fly.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const redis = yield* Fly.Redis("Cache", { eviction: true });
    const site = yield* Fly.Website.Vinext("Vinext", {
      redis,
      memo: {
        include: [
          "app/**",
          "public/**",
          "package.json",
          "vite.config.ts",
          "tsconfig.json",
        ],
      },
      env: {
        GREETING: "Hello from vinext on Fly!",
      },
    });

    return {
      url: site.url,
    };
  }),
);
