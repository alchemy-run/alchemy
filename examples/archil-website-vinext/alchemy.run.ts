import * as Archil from "@alchemy.run/archil";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "ArchilWebsiteVinextExample",
  {
    providers: Archil.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const site = yield* Archil.Website.Vinext("Vinext", {
      memo: {
        lockfile: true,
        include: ["app/**", "public/**", "package.json", "vite.config.ts", "tsconfig.json"],
      },
      env: {
        GREETING: "Hello from vinext on Archil!",
      },
    });

    return {
      url: site.url,
    };
  }),
);
