import * as Modal from "@alchemy.run/modal";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as secret from "@distilled.cloud/modal/secret";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { expectFound } from "./lookup.ts";

const { test } = Test.make({ providers: Modal.providers() });

const keysOf = (id: string) =>
  secret.secretGetInfo({ secretId: id }).pipe(
    Effect.map((response) => [...(response.metadata?.keys ?? [])].sort()),
    Effect.catchTag("SecretNotFound", () => Effect.succeed(undefined)),
  );

test.provider(
  "create, overwrite, and delete a secret",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Modal.Secret("Secret", { env: { A: "1", B: Redacted.make("2") } });
        }),
      );
      yield* expectFound(Modal.Secret.lookup({ name: created.name }), created);
      expect(yield* keysOf(created.secretId)).toEqual(["A", "B"]);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Modal.Secret("Secret", { env: { C: "3" } });
        }),
      );
      // Modal overwrites a secret under a new id; the name stays.
      expect(updated.name).toBe(created.name);
      expect(yield* keysOf(updated.secretId)).toEqual(["C"]);

      yield* stack.destroy();
      expect(yield* keysOf(updated.secretId)).toBeUndefined();
    }),
  { tags: ["provider:modal", "provider:modal:secret", "live"], timeout: 120_000 },
);
