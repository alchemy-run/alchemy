import * as Daytona from "@alchemy.run/daytona";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as registries from "@distilled.cloud/daytona/docker_registry";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { expectFound } from "./lookup.ts";

const { test } = Test.make({ providers: Daytona.providers() });

const find = (id: string) =>
  registries.getRegistry({ id }).pipe(Effect.catchTag("RegistryNotFound", () => Effect.undefined));

test.provider(
  "register a private registry, update its credentials, delete it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Daytona.Registry("Ghcr", {
          url: "ghcr.io",
          username: "alchemy-test",
          password: Redacted.make("not-a-real-token"),
          project: "alchemy-run",
        }),
      );
      yield* expectFound(Daytona.Registry.lookup({ name: created.name }), created);
      const observed = yield* registries.getRegistry({ id: created.registryId });
      expect(observed.url).toEqual("ghcr.io");
      expect(observed.username).toEqual("alchemy-test");

      const updated = yield* stack.deploy(
        Daytona.Registry("Ghcr", {
          url: "ghcr.io",
          username: "alchemy-test-2",
          password: Redacted.make("still-not-real"),
          project: "alchemy-run",
        }),
      );
      expect(updated.registryId).toEqual(created.registryId);
      expect((yield* registries.getRegistry({ id: created.registryId })).username).toEqual(
        "alchemy-test-2",
      );

      yield* stack.destroy();
      expect(yield* find(created.registryId)).toBeUndefined();
    }),
  { tags: ["provider:daytona", "live"], timeout: 120_000 },
);
