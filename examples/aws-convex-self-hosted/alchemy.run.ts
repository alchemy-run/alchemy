import * as AWS from "@alchemy.run/aws";
import * as Convex from "@alchemy.run/convex/aws";
import * as Alchemy from "alchemy";
import { Stage } from "alchemy/Stage";
import * as Effect from "effect/Effect";
import { Platform } from "./stacks/platform.ts";

export default Alchemy.Stack(
  "ConvexApp",
  { providers: Convex.providers(), state: AWS.state() },
  Effect.gen(function* () {
    const stage = yield* Stage;
    const isProd = stage === "prod";

    // Every stage but prod shares the development account's platform.
    const { convex } = yield* Platform.stage[isProd ? "prod" : "dev"]!;

    const backend = yield* Convex.Backend("Backend", {
      platform: convex,
      // Pinned, because Convex migrations only go forward.
      image:
        "ghcr.io/convex/convex-backend:latest@sha256:207cf95def42f01614b6e3af0af5c20d0dcaa5ff2adf258ee7bc9555576644fa",
      cpu: 512,
      memory: 1024,
    });

    yield* Convex.Functions("Functions", { backend, rootDir: "." });

    const website = yield* AWS.Website.TanStackStart("Website", {
      env: { CONVEX_URL: backend.url },
      forceDestroy: !isProd,
    });

    return { convexUrl: backend.url, websiteUrl: website.url };
  }),
);
