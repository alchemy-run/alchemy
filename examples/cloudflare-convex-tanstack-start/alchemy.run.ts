// alchemy.run.ts
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Convex from "@alchemy.run/convex";
import * as Alchemy from "alchemy";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import { Stage } from "alchemy/Stage";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export default Alchemy.Stack(
  "CloudflareConvexTanStackStartExample",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Convex.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const stage = yield* Stage;
    const isProd = stage === "prod";

    const project = yield* Convex.Project("App").pipe(RemovalPolicy.retain(isProd));

    // Production gets the prod deployment. Every other stage gets its own
    // preview, which `alchemy destroy` removes.
    const deployment = yield* Convex.Deployment("Backend", {
      project,
      type: isProd ? "prod" : "preview",
    });

    yield* Convex.Functions("Functions", { deployment, rootDir: "./packages/backend" });

    // For CI: one pushes to this deployment, the other creates previews.
    const deployKey = yield* Convex.DeployKey("Deploy", {
      deployment,
      allowedActions: ["deployment:deploy"],
    });
    const previewKey = yield* Convex.PreviewDeployKey("Preview", { project });

    const website = yield* Cloudflare.Website.Vite("Website", {
      rootDir: "apps/web",
      env: { CONVEX_URL: deployment.url },
    });

    return {
      convexUrl: deployment.url,
      websiteUrl: website.url.as<string>(),
      projectId: project.projectId,
      deploymentName: deployment.deploymentName,
      deployKeyName: deployKey.name,
      previewKeyName: previewKey.name,
    };
  }),
);
