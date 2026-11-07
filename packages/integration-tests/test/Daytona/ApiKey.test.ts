import * as Daytona from "@alchemy.run/daytona";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as apiKeys from "@distilled.cloud/daytona/api_keys";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const { test } = Test.make({ providers: Daytona.providers() });

const exists = (name: string) =>
  apiKeys.getApiKey({ name }).pipe(
    Effect.as(true),
    Effect.catchTag("ApiKeyNotFound", () => Effect.succeed(false)),
  );

test.provider(
  "create an API key, replace it when permissions change, delete it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Daytona.ApiKey("Key", { permissions: ["write:sandboxes", "delete:sandboxes"] }),
      );
      expect(Redacted.value(created.value)).not.toEqual("");
      expect([...created.permissions].sort()).toEqual(["delete:sandboxes", "write:sandboxes"]);
      expect(created.organizationId).not.toEqual("");
      const observed = yield* apiKeys.getApiKey({ name: created.name });
      expect([...observed.permissions].sort()).toEqual(["delete:sandboxes", "write:sandboxes"]);

      // Unchanged props keep the same key and value.
      const again = yield* stack.deploy(
        Daytona.ApiKey("Key", { permissions: ["delete:sandboxes", "write:sandboxes"] }),
      );
      expect(Redacted.value(again.value)).toEqual(Redacted.value(created.value));

      // Keys can't be edited: new permissions mint a new key.
      const replaced = yield* stack.deploy(
        Daytona.ApiKey("Key", { permissions: ["read:volumes"] }),
      );
      expect(Redacted.value(replaced.value)).not.toEqual(Redacted.value(created.value));
      expect(replaced.permissions).toEqual(["read:volumes"]);

      yield* stack.destroy();
      expect(yield* exists(replaced.name)).toBe(false);
      expect(yield* exists(created.name)).toBe(false);
    }),
  { tags: ["provider:daytona", "live"], timeout: 120_000 },
);
