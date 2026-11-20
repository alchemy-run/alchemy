import * as AWS from "@alchemy.run/aws";
import * as Convex from "@alchemy.run/convex/aws";
import * as Alchemy from "alchemy";
import { Stage } from "alchemy/Stage";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { Platform } from "./stacks/platform.ts";

export default Alchemy.Stack(
  "ConvexApp",
  { providers: Convex.providers(), state: AWS.state() },
  Effect.gen(function* () {
    const stage = yield* Stage;
    const isProd = stage === "prod";
    const domain = yield* Config.String("CONVEX_DOMAIN");

    // Every stage but prod shares the development account's platform.
    // CONVEX_PLATFORM_STAGE points a stage at another platform deployment.
    const platformStage = yield* Config.String("CONVEX_PLATFORM_STAGE").pipe(
      Config.withDefault(isProd ? "prod" : "dev"),
    );
    const { convex } = yield* Platform.stage[platformStage]!;

    const backend = yield* Convex.Backend("Backend", {
      platform: convex,
      // A preview keeps SQLite on its task's disk, so it's up in minutes. Its data
      // starts over with each new task, and Functions pushes again then.
      db: isProd ? undefined : { engine: "sqlite" },
      // Pinned, because Convex migrations only go forward.
      image:
        "ghcr.io/convex/convex-backend:latest@sha256:207cf95def42f01614b6e3af0af5c20d0dcaa5ff2adf258ee7bc9555576644fa",
      cpu: 512,
      memory: 1024,
    });

    yield* Convex.Functions("Functions", { backend, rootDir: "." });

    const website = yield* AWS.Website.TanStackStart("Website", {
      // `<stage>.<domain>` for a preview, the bare domain for prod.
      domain: { name: Convex.stageHosts(domain, stage, isProd).web },
      // The address, not the running backend, so the site builds in parallel.
      env: { CONVEX_URL: backend.endpoints.url },
      forceDestroy: !isProd,
    });

    return { convexUrl: backend.url, websiteUrl: website.url };
  }),
);
