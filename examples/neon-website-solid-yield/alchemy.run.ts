import * as Alchemy from "alchemy";
import * as Neon from "alchemy/Neon";
import * as Effect from "effect/Effect";
import Api from "./src/api.ts";
import { Project } from "./src/project.ts";

export default Alchemy.Stack(
  "NeonWebsiteSolidYieldExample",
  { providers: Neon.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const project = yield* Project;
    const api = yield* Api;
    const site = yield* Neon.Website.SolidYield("Web", {
      // Share the API's project instead of provisioning a second one.
      project,
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
