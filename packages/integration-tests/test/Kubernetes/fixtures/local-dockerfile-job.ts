import * as Kubernetes from "@alchemy.run/kubernetes";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { TestLocalCluster } from "./local.ts";

export const BUILD_SECRET = "alchemy-build-secret-value";

/**
 * A one-shot Job built from `buildsecrets/Dockerfile` with a build arg, a
 * BuildKit secret and a registry layer cache, pushed to the
 * cluster's registry. It prints the file its build wrote.
 */
export default Kubernetes.Job(
  "LocalDockerfileJob",
  Effect.gen(function* () {
    const cluster = yield* TestLocalCluster;
    return {
      cluster,
      context: `${import.meta.dirname}/buildsecrets`,
      build: {
        args: { GREETING: "hello" },
        secrets: { token: Redacted.make(BUILD_SECRET) },
        // Every stage's layers at the image repository's `:buildcache`.
        cache: true,
      },
      name: "local-dockerfile-job",
      backoffLimit: 0,
    };
  }),
);
