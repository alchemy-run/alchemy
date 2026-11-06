import * as Archil from "@alchemy.run/archil";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "ArchilWebsiteNextjsExample",
  {
    providers: Archil.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const site = yield* Archil.Website.Nextjs("Nextjs", {
      // Only hash the files that affect the build, so unchanged sources
      // skip the Node build (and the deploy) entirely.
      memo: {
        include: [
          "app/**",
          "public/**",
          "package.json",
          "next.config.mjs",
          "postcss.config.mjs",
          "tsconfig.json",
        ],
      },
      env: {
        GREETING: "Hello from Next.js on Archil!",
      },
    });

    return {
      url: site.url,
    };
  }),
);
