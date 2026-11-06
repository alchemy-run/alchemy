import * as Archil from "@alchemy.run/archil";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "ArchilWebsiteTanStackStartExample",
  {
    providers: Archil.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const site = yield* Archil.Website.TanStackStart("Website", {
      // Only hash the files that affect the build, so unchanged sources
      // skip the Vite build (and the deploy) entirely.
      memo: {
        include: ["src/**", "package.json", "vite.config.ts"],
      },
      env: {
        GREETING: "Hello from TanStack Start on Archil!",
      },
    });

    return {
      url: site.url,
    };
  }),
);
