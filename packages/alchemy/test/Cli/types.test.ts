import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { describe, expect, test } from "vitest";

import { _internal } from "../../src/Cli/commands/types";
import { assertValidStage } from "../../src/Cli/commands/_shared";
import { STAGES_META, readStagesMeta } from "../../src/Stack";

describe("renderDeclaration", () => {
  test("emits an augmentation that narrows Stages to the literal union", () => {
    const out = _internal.renderDeclaration(["dev", "staging", "prod"]);
    expect(out).toContain('declare module "alchemy"');
    expect(out).toContain("interface Stages");
    expect(out).toContain('"dev": true;');
    expect(out).toContain('"staging": true;');
    expect(out).toContain('"prod": true;');
    // Must be a module so `declare module` is augmentation, not ambient
    // redefinition.
    expect(out).toContain("export {};");
  });

  test("escapes stage names that aren't bare identifiers", () => {
    // The generator just JSON.stringifies, so we should be safe against
    // a stage like `dev"injected`.
    const out = _internal.renderDeclaration(['weird"name']);
    expect(out).toContain('"weird\\"name": true;');
  });
});

describe("renderEmptyDeclaration", () => {
  test("emits a no-op module that keeps Stage as string", () => {
    const out = _internal.renderEmptyDeclaration();
    expect(out).toContain("export {};");
    expect(out).not.toContain("declare module");
  });
});

describe("readStagesMeta", () => {
  test("extracts the meta from an object that carries the symbol", () => {
    const carrier = {
      [STAGES_META]: { name: "Foo", stages: ["dev", "prod"] as const },
    };
    expect(readStagesMeta(carrier)).toEqual({
      name: "Foo",
      stages: ["dev", "prod"],
    });
  });

  test("returns undefined for foreign objects", () => {
    expect(readStagesMeta({})).toBeUndefined();
    expect(readStagesMeta(null)).toBeUndefined();
    expect(readStagesMeta(42)).toBeUndefined();
  });
});

describe("assertValidStage", () => {
  const carrier = (stages: readonly string[] | undefined) => ({
    [STAGES_META]: { name: "Foo", stages },
  });

  test("no-ops when no whitelist is declared", async () => {
    const result = await Effect.runPromise(
      assertValidStage(carrier(undefined), "anything"),
    );
    expect(result).toBeUndefined();
  });

  test("no-ops when the whitelist is empty", async () => {
    const result = await Effect.runPromise(
      assertValidStage(carrier([]), "anything"),
    );
    expect(result).toBeUndefined();
  });

  test("accepts a stage that's in the whitelist", async () => {
    const result = await Effect.runPromise(
      assertValidStage(carrier(["dev", "prod"]), "dev"),
    );
    expect(result).toBeUndefined();
  });

  test("dies with a helpful message when the stage isn't whitelisted", async () => {
    const exit = await Effect.runPromiseExit(
      assertValidStage(carrier(["dev", "prod"]), "preprod"),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const pretty = Cause.pretty(exit.cause);
      expect(pretty).toContain('Invalid stage "preprod"');
      expect(pretty).toContain('"dev"');
      expect(pretty).toContain('"prod"');
      expect(pretty).toContain('stack "Foo"');
    }
  });
});
