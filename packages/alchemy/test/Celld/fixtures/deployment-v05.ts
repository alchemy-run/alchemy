import { prepareDeployment } from "@/Celld/Deployment.ts";
import * as Effect from "effect/Effect";

/** Pure artifact fixture for the parent's real v0.5 node integration test. */
export const prepareV05PublicationFixture = Effect.gen(function* () {
  const worker = yield* prepareDeployment({
    scriptName: "alchemy-fixture-service",
    mainModule: "index.js",
    modules: [
      {
        name: "index.js",
        content:
          'export default { fetch() { return Response.json({ runtime: "celld", publication: "api-only" }); } };\n',
      },
    ],
    metadata: {
      main_module: "index.js",
      compatibility_date: "2026-09-01",
      bindings: [],
    },
    doClasses: [],
    sqliteClasses: [],
  });
  const root = yield* prepareDeployment({
    scriptName: "alchemy-fixture-root",
    mainModule: "index.js",
    modules: [
      {
        name: "index.js",
        content:
          "export default { fetch(request, env) { return env.SERVICE.fetch(request); } };\n",
      },
    ],
    metadata: {
      main_module: "index.js",
      compatibility_date: "2026-09-01",
      bindings: [
        { type: "service", name: "SERVICE", service: worker.scriptName },
      ],
    },
    doClasses: [],
    sqliteClasses: [],
  });
  return { rootPreparedDeployment: root, workers: [worker] };
});
