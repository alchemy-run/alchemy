import * as Fly from "@alchemy.run/fly";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as machines from "@distilled.cloud/fly-io/machines";
import * as Output from "alchemy/Output";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
import { flyApi } from "./limit.ts";

const { test } = Test.make({ limit: flyApi, providers: Fly.providers() });

const tags = ["provider:fly", "provider:fly:app", "provider:fly:secret", "live"];

// The target belongs to another stack, as a lookup's target always should.
const target = () => Core.scratchStack({ providers: Fly.providers() }, "FlyLookupTarget");

describe.concurrent("lookup", () => {
  test.provider(
    "a looked-up App holds a declared Secret and survives its destroy",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const owner = target();
        yield* owner.destroy();
        const app = yield* owner.deploy(Fly.App("LookupTarget"));

        const program = Fly.Secret("OnLookedUpApp", {
          app: Fly.App.lookup({ name: app.appName }),
          value: Redacted.make("looked-up"),
        });
        const secret = yield* stack.deploy(program);
        expect(secret.appName).toEqual(app.appName);
        const stored = yield* machines.getSecret({
          app_name: app.appName,
          secret_name: secret.name,
          show_secrets: false,
        });
        expect(stored.name).toEqual(secret.name);

        // A lookup re-resolves to the same App.
        const plan = yield* stack.plan(program);
        expect(plan.resources.OnLookedUpApp?.action).toEqual("noop");

        // Destroying the consumer removes the Secret, never the App.
        yield* stack.destroy();
        const after = yield* machines.getApp({ app_name: app.appName });
        expect(after.name).toEqual(app.appName);
        const gone = yield* machines
          .getSecret({ app_name: app.appName, secret_name: secret.name, show_secrets: false })
          .pipe(
            Effect.as("found" as const),
            Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
          );
        expect(gone).toEqual("gone");

        yield* owner.destroy();
      }),
    { tags, timeout: 180_000 },
  );

  test.provider(
    "a lookup of a resource that doesn't exist fails the plan",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const owner = target();
        yield* owner.destroy();
        // Children are looked up in an App that exists, so only the child
        // itself is missing.
        const app = yield* owner.deploy(Fly.App("LookupMissingTarget"));
        const appName = app.appName;
        const missing = `alchemy-missing-${appName}`.slice(0, 30);

        const lookups: Record<string, Output.Output<unknown>> = {
          App: Fly.App.lookup({ name: missing }),
          Machine: Fly.Machine.lookup({ appName, name: "missing" }),
          Service: Fly.Service.lookup({ appName }),
          Secret: Fly.Secret.lookup({ appName, name: "MISSING" }),
          SecretKey: Fly.SecretKey.lookup({ appName, name: "missing" }),
          Certificate: Fly.Certificate.lookup({ appName, hostname: "missing.alchemy.run" }),
          IpAssignment: Fly.IpAssignment.lookup({ appName, ip: "2a09:8280:1::dead" }),
          VolumeSnapshot: Fly.VolumeSnapshot.lookup({
            appName,
            volumeId: "vol_missing",
            snapshotId: "vs_missing",
          }),
          Bucket: Fly.Bucket.lookup({ name: missing }),
          Redis: Fly.Redis.lookup({ name: missing }),
          Postgres: Fly.Postgres.lookup({ name: missing }),
          Sprite: Fly.Sprite.lookup({ name: missing }),
        } as unknown as Record<string, Output.Output<unknown>>;

        const mismatches: Record<string, string> = {};
        for (const [id, lookup] of Object.entries(lookups)) {
          const exit = yield* Effect.exit(
            stack.plan(
              Effect.gen(function* () {
                const probe = yield* Fly.App("lookup-missing-probe");
                return yield* Fly.Secret(id, {
                  app: probe,
                  value: Output.interpolate`${lookup}`,
                });
              }),
            ),
          );
          const pretty = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "plan succeeded";
          if (!pretty.includes("LookupNotFoundError")) {
            mismatches[id] = pretty.split("\n")[0]!.slice(0, 300);
          }
        }
        expect(mismatches).toEqual({});

        yield* owner.destroy();
      }),
    { tags, timeout: 180_000 },
  );
});
