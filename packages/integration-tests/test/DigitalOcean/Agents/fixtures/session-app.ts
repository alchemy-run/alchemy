import * as DigitalOcean from "@alchemy.run/digitalocean";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { TestRegistry } from "../../fixtures/app/shared.ts";

export const Shell = DigitalOcean.Agents.EnvironmentConfig("Shell", {
  manifest: {
    apiVersion: "agents.digitalocean.com/v1alpha1",
    kind: "Agent",
    spec: { runtime: { adapter: "opencode" } },
  },
});

/** Starts a session per request, runs a command in its sandbox, deletes it. */
export default class SessionApp extends DigitalOcean.App<SessionApp>()(
  "SessionApp",
  { main: import.meta.url, registry: TestRegistry, region: "nyc" },
  Effect.gen(function* () {
    const env = yield* Shell;
    const token = yield* Config.Redacted("DO_TEST_KEY");
    const sessions = yield* DigitalOcean.Agents.CreateSession(env, { token });
    return {
      fetch: Effect.gen(function* () {
        const session = yield* Effect.acquireRelease(sessions.create(), (s) =>
          Effect.ignore(s.delete),
        );
        const result = yield* session.exec(["sh", "-c", "echo from-the-sandbox"]);
        return yield* HttpServerResponse.json({
          id: session.sessionId,
          stdout: result.stdout.trim(),
        });
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(DigitalOcean.Agents.CreateSessionHttp)),
) {}
