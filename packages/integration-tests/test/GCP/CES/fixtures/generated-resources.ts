import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";

/** CES resources the generated bindings bind, mirroring each resource suite's smallest shape. */

export const ProbeApp = GCP.CES.App("ProbeApp", {
  location: "us",
  displayName: "support",
  description: "help desk",
  timeZone: "America/Los_Angeles",
});

export const ProbeAgent = Effect.gen(function* () {
  const app = yield* ProbeApp;
  return yield* GCP.CES.AppsAgent("ProbeAgent", {
    app: app.name,
    displayName: "greeter",
    instruction: "Greet the user.",
  });
});
export const ProbeTool = Effect.gen(function* () {
  const app = yield* ProbeApp;
  return yield* GCP.CES.AppsTool("ProbeTool", {
    app: app.name,
    clientFunction: {
      name: "lookup_order",
      description: "Look up an order.",
      parameters: { type: "OBJECT", properties: { orderId: { type: "STRING" } } },
    },
  });
});
export const ProbeGuardrail = Effect.gen(function* () {
  const app = yield* ProbeApp;
  return yield* GCP.CES.AppsGuardrail("ProbeGuardrail", {
    app: app.name,
    displayName: "safety",
    contentFilter: { matchType: "SIMPLE_STRING_MATCH", bannedContents: ["forbidden"] },
  });
});
export const ProbeExample = Effect.gen(function* () {
  const app = yield* ProbeApp;
  return yield* GCP.CES.AppsExample("ProbeExample", {
    app: app.name,
    displayName: "hello",
    messages: [
      { role: "user", chunks: [{ text: "Hi" }] },
      { role: "agent", chunks: [{ text: "Hello!" }] },
    ],
  });
});
export const ProbeVersion = Effect.gen(function* () {
  const app = yield* ProbeApp;
  return yield* GCP.CES.AppsVersion("ProbeVersion", { app: app.name, displayName: "v1" });
});
export const ProbeDeployment = Effect.gen(function* () {
  const app = yield* ProbeApp;
  const version = yield* ProbeVersion;
  return yield* GCP.CES.AppsDeployment("ProbeDeployment", {
    app: app.name,
    appVersion: version.name,
    displayName: "prod",
    channelProfile: { channelType: "API", profileId: "api" },
  });
});

export const ProbeToolset = Effect.gen(function* () {
  const app = yield* ProbeApp;
  return yield* GCP.CES.AppsToolset("ProbeToolset", {
    app: app.name,
    displayName: "ping",
    openApiToolset: {
      openApiSchema: JSON.stringify({
        openapi: "3.0.0",
        info: { title: "Ping", version: "1.0.0" },
        servers: [{ url: "https://example.com" }],
        paths: {
          "/ping": { get: { operationId: "ping", responses: { "200": { description: "ok" } } } },
        },
      }),
    },
  });
});
