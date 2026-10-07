import * as Alchemy from "alchemy";
import * as Prisma from "alchemy/Prisma";
import * as Effect from "effect/Effect";
import Api, { Project, region } from "./src/api.ts";

export default Alchemy.Stack(
  "PrismaWebsiteSolidYieldExample",
  { providers: Prisma.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const project = yield* Project;
    const api = yield* Api;
    const site = yield* Prisma.Website.SolidYield("Web", {
      project,
      regionId: region,
      // Inlined into the client bundle at build time.
      env: { VITE_API_URL: api.url.as<string>() },
      // Only hash the files that affect the build, so unchanged sources
      // skip the Vite build (and the deploy) entirely.
      memo: {
        include: ["src/**", "index.html", "package.json", "vite.config.ts"],
      },
    });

    return {
      url: site.url,
      apiUrl: api.url,
      projectId: project.projectId,
    };
  }),
);
