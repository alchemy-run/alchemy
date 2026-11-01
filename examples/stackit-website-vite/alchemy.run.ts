import * as Stackit from "@alchemy.run/stackit";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "StackitWebsiteViteExample",
  {
    providers: Stackit.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    // A plain Vite SPA: the build's files in a private bucket behind the CDN.
    // No compute runs, so it needs no registry.
    const site = yield* Stackit.Website.Vite("Website", {
      // Only hash the files that affect the build, so unchanged sources
      // skip the Vite build (and the deploy) entirely.
      memo: {
        include: ["src/**", "index.html", "package.json", "vite.config.ts"],
      },
    });

    return {
      url: site.url,
      serverUrl: site.serverUrl,
      projectId: site.distribution?.projectId,
      distributionId: site.distribution?.distributionId,
      hostname: site.distribution?.hostname,
    };
  }),
);
