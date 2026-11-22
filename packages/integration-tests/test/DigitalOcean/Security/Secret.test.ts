import * as DigitalOcean from "@alchemy.run/digitalocean";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { getSecuritySecret } from "@distilled.cloud/digitalocean";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { logLevel, testName } from "../support.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

const LIVE_TAGS = ["provider:digitalocean", "provider:digitalocean:security", "live"];

const observedValues = (name: string) =>
  getSecuritySecret({ secret: name, region: "nyc3" }).pipe(
    Effect.map((secret) => ({
      version: secret.version,
      pending: secret.delete_requested_at !== undefined,
      values:
        secret.values === undefined || secret.values === null
          ? undefined
          : Object.fromEntries(
              Object.entries(secret.values).map(([key, value]) => [
                key,
                value === undefined || typeof value === "string" ? value : Redacted.value(value),
              ]),
            ),
    })),
  );

test.provider(
  "secret lifecycle: create, write a new version, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        DigitalOcean.Security.Secret("Secret", {
          values: { API_KEY: Redacted.make("one"), MODE: "test" },
        }),
      );
      expect(created.version).toEqual(1);
      expect(yield* observedValues(created.name)).toEqual({
        version: 1,
        pending: false,
        values: { API_KEY: "one", MODE: "test" },
      });

      const updated = yield* stack.deploy(
        DigitalOcean.Security.Secret("Secret", { values: { API_KEY: Redacted.make("two") } }),
      );
      expect(updated.name).toEqual(created.name);
      expect(updated.version).toEqual(2);
      expect((yield* observedValues(created.name)).values).toEqual({ API_KEY: "two" });

      // Redeploying unchanged writes no version.
      const plan = yield* stack.plan(
        DigitalOcean.Security.Secret("Secret", { values: { API_KEY: Redacted.make("two") } }),
      );
      expect(plan.resources.Secret?.action).toEqual("noop");

      yield* stack.destroy();
      // A deleted secret stays pending deletion.
      expect((yield* observedValues(created.name)).pending).toBe(true);
    }).pipe(logLevel),
  { tags: LIVE_TAGS },
);

test.provider(
  "a chosen name pending deletion is restored on the next deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = testName(stack.stage, "secret").slice(0, 63);
      const secret = DigitalOcean.Security.Secret("Named", { name, values: { A: "1" } });

      yield* stack.deploy(secret);
      yield* stack.destroy();
      expect((yield* observedValues(name)).pending).toBe(true);

      const restored = yield* stack.deploy(
        DigitalOcean.Security.Secret("Named", { name, values: { A: "2" } }),
      );
      expect(restored.name).toEqual(name);
      expect(yield* observedValues(name)).toMatchObject({ pending: false, values: { A: "2" } });

      yield* stack.destroy();
      expect((yield* observedValues(name)).pending).toBe(true);
    }).pipe(logLevel),
  { tags: LIVE_TAGS },
);
