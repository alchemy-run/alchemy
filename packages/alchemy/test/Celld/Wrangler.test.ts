import {
  CelldMigrationConflictError,
  computeFleetMigrations,
  renderWranglerJson,
} from "@/Celld/Wrangler";
import { describe, expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

const run = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runSync(Effect.result(effect));

describe("Celld Wrangler", () => {
  describe("computeFleetMigrations", () => {
    test("first deploy emits new_sqlite_classes for every binding", () => {
      const result = run(
        computeFleetMigrations({
          current: [
            { name: "Counter", className: "Counter" },
            { name: "Meter", className: "MeterV1" },
          ],
        }),
      );
      expect(Result.isSuccess(result)).toBe(true);
      if (Result.isSuccess(result)) {
        expect(result.success.migrations).toEqual([
          { tag: "v1", new_sqlite_classes: ["Counter", "MeterV1"] },
        ]);
        expect(result.success.classes).toEqual({
          Counter: "Counter",
          Meter: "MeterV1",
        });
      }
    });

    test("no changes appends nothing and keeps the history", () => {
      const history = [{ tag: "v1", new_sqlite_classes: ["Counter"] }];
      const result = run(
        computeFleetMigrations({
          history,
          oldClasses: { Counter: "Counter" },
          current: [{ name: "Counter", className: "Counter" }],
        }),
      );
      expect(Result.isSuccess(result)).toBe(true);
      if (Result.isSuccess(result)) {
        expect(result.success.migrations).toEqual(history);
      }
    });

    test("rename, create, and delete combine into one tagged delta", () => {
      const result = run(
        computeFleetMigrations({
          history: [{ tag: "v1", new_sqlite_classes: ["Counter", "Old"] }],
          oldClasses: { Counter: "Counter", Legacy: "Old" },
          current: [
            { name: "Counter", className: "CounterV2" },
            { name: "Fresh", className: "Fresh" },
          ],
        }),
      );
      expect(Result.isSuccess(result)).toBe(true);
      if (Result.isSuccess(result)) {
        expect(result.success.migrations.at(-1)).toEqual({
          tag: "v2",
          new_sqlite_classes: ["Fresh"],
          renamed_classes: [{ from: "Counter", to: "CounterV2" }],
          deleted_classes: ["Old"],
        });
      }
    });

    test("rename target colliding with a delete fails before deploy", () => {
      const result = run(
        computeFleetMigrations({
          oldClasses: { A: "ClassA", B: "ClassB" },
          current: [{ name: "A", className: "ClassB" }],
        }),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(CelldMigrationConflictError);
      }
    });

    test("duplicate class names across bindings fail", () => {
      const result = run(
        computeFleetMigrations({
          current: [
            { name: "A", className: "Shared" },
            { name: "B", className: "Shared" },
          ],
        }),
      );
      expect(Result.isFailure(result)).toBe(true);
    });
  });

  describe("renderWranglerJson", () => {
    test("emits only celld-supported keys", () => {
      const json = JSON.parse(
        renderWranglerJson({
          name: "my-fleet",
          main: "index.js",
          compatibilityDate: "2025-06-01",
          compatibilityFlags: ["nodejs_compat"],
          durableObjects: [{ name: "Counter", className: "Counter" }],
          migrations: [{ tag: "v1", new_sqlite_classes: ["Counter"] }],
          vars: { ALCHEMY_FLEET_SECRET: "shh" },
        }),
      );
      expect(Object.keys(json).sort()).toEqual([
        "compatibility_date",
        "compatibility_flags",
        "durable_objects",
        "main",
        "migrations",
        "name",
        "vars",
      ]);
      expect(json.durable_objects).toEqual({
        bindings: [{ name: "Counter", class_name: "Counter" }],
      });
      expect(json.migrations).toEqual([
        { tag: "v1", new_sqlite_classes: ["Counter"] },
      ]);
    });

    test("omits empty sections entirely", () => {
      const json = JSON.parse(
        renderWranglerJson({
          name: "empty",
          main: "index.js",
          compatibilityDate: "2025-06-01",
          durableObjects: [],
          migrations: [],
        }),
      );
      expect(Object.keys(json).sort()).toEqual([
        "compatibility_date",
        "main",
        "name",
      ]);
    });
  });
});
