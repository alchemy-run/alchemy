import * as Render from "@alchemy.run/render";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "RenderWebServiceExample",
  {
    providers: Render.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const site = yield* Render.Project("Site", {
      environments: {
        staging: { name: "staging", protectedStatus: "unprotected" },
      },
    });

    const web = yield* Render.WebService("Web", {
      plan: "free",
      region: "oregon",
      environmentId: site.environments.staging.id,
      waitForDeployCompletion: true,
      runtimeSource: {
        image: {
          imagePath: "docker.io/nginxdemos/hello",
          tag: "plain-text",
        },
      },
    });

    return {
      url: web.url,
      projectId: site.id,
      serviceId: web.id,
    };
  }),
);
