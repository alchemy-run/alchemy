import * as Axiom from "@alchemy.run/axiom";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import { expectFound } from "./lookup.ts";

const { test } = Test.make({ providers: Axiom.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

// Deterministic notifier name so re-runs reconcile the same notifier rather
// than piling up duplicates.
const NOTIFIER_NAME = "alchemy-test-notifier-list";

test.provider(
  "list enumerates the deployed notifier",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Axiom.Notifier("ListNotifier", {
            name: NOTIFIER_NAME,
            properties: {
              email: { emails: ["sre@example.com"] },
            },
          });
        }),
      );
      yield* expectFound(Axiom.Notifier.lookup({ id: deployed.id }), deployed);

      const provider = yield* Provider.findProvider(Axiom.Notifier);
      const all = yield* provider.list();

      // `getNotifiers` returns the full account-wide list in one shot; the
      // freshly created notifier must be present, hydrated into the exact
      // `read` shape (so `.id` / `.name` are directly usable by `delete`).
      const found = all.find((n) => n.id === deployed.id);
      expect(found).toBeDefined();
      expect(found?.name).toEqual(NOTIFIER_NAME);

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:axiom", "provider:axiom:notifier", "live"],
    timeout: 120_000,
  },
);
