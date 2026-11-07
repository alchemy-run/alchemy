import * as Archil from "@alchemy.run/archil";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "ArchilWebsiteSolidStartExample",
  {
    providers: Archil.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const site = yield* Archil.Website.SolidStart("Website", {
      // Only hash the files that affect the build, so unchanged sources
      // skip the SolidStart build (and the deploy) entirely.
      memo: {
        include: ["src/**", "public/**", "package.json", "vite.config.ts"],
      },
      env: {
        GREETING: "Hello from SolidStart on Archil!",
      },
    });

    return {
      url: site.url,
    };
  }),
);
