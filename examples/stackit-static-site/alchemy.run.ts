import * as Stackit from "@alchemy.run/stackit";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "StackitStaticSiteExample",
  {
    providers: Stackit.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const site = yield* Stackit.Website.StaticSite("MarketingSite", {
      // `site/` is plain files, so the build only copies them to the output.
      command: "rm -rf dist && cp -R site dist",
      shell: true,
      outdir: "dist",
      memo: { include: ["site/**"] },
      // domain: "your.domain.com",
      tags: { example: "stackit-static-site" },
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
