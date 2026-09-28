import { prepareDeployment } from "@/Celld/Deployment.ts";
import * as Effect from "effect/Effect";

export const activationOwner = {
  stack: "CelldIntegration",
  stage: "test",
  fqn: "Application",
  instanceId: "0123456789abcdef0123456789abcdef",
};

// Public credentials and loopback endpoints belong only to the retained local fixture.
export const activationConnection = {
  fleetId: "CelldIntegration/Cells",
  fleetUrl: "http://127.0.0.1:56994",
  bucket: {
    uri: "s3://alchemy-celld-v05-d1-live",
    endpoint: "http://127.0.0.1:59936",
    region: "us-east-1",
  },
};
export const activationCredentials = {
  AWS_ACCESS_KEY_ID: "alchemy-test",
  AWS_SECRET_ACCESS_KEY: "alchemy-test-secret",
  AWS_REGION: "us-east-1",
};
export const activationPrivateEndpoint = "http://172.19.0.3:8081";
export const activationMappedEndpoint = "http://127.0.0.1:56995";
export const activationPublicEndpoint = "http://127.0.0.1:56994";

export const prepareActivationSources = (
  secondary: "one" | "two",
  cron: string,
) =>
  Effect.gen(function* () {
    const root = yield* prepareDeployment({
      scriptName: "activation-root",
      mainModule: "main.js",
      modules: [
        {
          name: "main.js",
          content:
            "export default { fetch(request, env) { return env.__ALCHEMY_APP_WORKER_0.fetch(request); }, scheduled() {} };",
        },
      ],
      metadata: { main_module: "main.js", compatibility_date: "2026-09-01" },
      doClasses: [],
      sqliteClasses: [],
      crons: [cron],
    });
    const worker = yield* prepareDeployment({
      scriptName: "activation-secondary",
      mainModule: "main.js",
      modules: [
        {
          name: "main.js",
          content: `export default { fetch() { return new Response("activation-secondary-${secondary}"); } };`,
        },
      ],
      metadata: { main_module: "main.js", compatibility_date: "2026-09-01" },
      doClasses: [],
      sqliteClasses: [],
    });
    return { root, worker };
  });
