import * as DigitalOcean from "@alchemy.run/digitalocean";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Schedule from "effect/Schedule";
import { TestRegistry } from "../../fixtures/app/shared.ts";

export const Shell = DigitalOcean.Agents.EnvironmentConfig("Shell", {
  manifest: {
    apiVersion: "agents.digitalocean.com/v1alpha1",
    kind: "Agent",
    spec: { runtime: { adapter: "opencode" } },
  },
});

/**
 * Starts a session per request, runs a command in its sandbox, deletes it.
 * `/fork` also forks the session and runs the command in the child.
 */
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
        const request = yield* HttpServerRequest;
        if (request.url.startsWith("/fork")) {
          yield* session.exec(["sh", "-c", "echo forked > /tmp/marker"]);
          const children = yield* Effect.acquireRelease(session.fork({ count: 1 }), (cs) =>
            Effect.forEach(cs, (c) => Effect.ignore(c.delete)),
          );
          const child = yield* session
            .exec(["cat", "/tmp/marker"])
            .pipe(
              Effect.andThen(children[0]!.exec(["cat", "/tmp/marker"])),
              Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }),
            );
          return yield* HttpServerResponse.json({
            id: session.sessionId,
            children: children.map((c) => c.sessionId),
            stdout: child.stdout.trim(),
          });
        }
        const result = yield* session.exec(["sh", "-c", "echo from-the-sandbox"]);
        return yield* HttpServerResponse.json({
          id: session.sessionId,
          stdout: result.stdout.trim(),
        });
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(DigitalOcean.Agents.CreateSessionHttp)),
) {}
