import * as DigitalOcean from "@alchemy.run/digitalocean";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { TestRegistry } from "../../fixtures/app/shared.ts";

export const Base = DigitalOcean.Sandboxes.Template("AppBase", {
  image: "alpine:3.20",
  setup: ["echo from-the-base > /etc/alchemy-marker"],
});

/** Creates a sandbox per request, runs a command in it, deletes it. */
export default class SandboxApp extends DigitalOcean.App<SandboxApp>()(
  "SandboxApp",
  { main: import.meta.url, registry: TestRegistry, region: "nyc" },
  Effect.gen(function* () {
    const token = yield* Config.Redacted("DO_TEST_KEY");
    const sandboxes = yield* DigitalOcean.Sandboxes.CreateSandbox(Base, { token });
    return {
      fetch: Effect.gen(function* () {
        const sandbox = yield* Effect.acquireRelease(sandboxes.create(), (s) =>
          Effect.ignore(s.delete),
        );
        const result = yield* sandbox.exec("cat /etc/alchemy-marker");
        return yield* HttpServerResponse.json({
          stdout: result.stdout.trim(),
          id: sandbox.sandboxId,
        });
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(DigitalOcean.Sandboxes.CreateSandboxHttp)),
) {}
