import * as Alchemy from "alchemy";
import * as Railway from "alchemy/Railway";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "RailwayWebsiteVinextExample",
  {
    providers: Railway.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const project = yield* Railway.Project("Project");
    const redis = yield* Railway.Redis("Cache", { project });
    const site = yield* Railway.Website.Vinext("Vinext", {
      project,
      memo: {
        include: [
          "app/**",
          "public/**",
          "package.json",
          "vite.config.ts",
          "tsconfig.json",
        ],
      },
      redis,
      env: {
        GREETING: "Hello from vinext on Railway!",
      },
    });

    return {
      url: site.url,
    };
  }),
);
