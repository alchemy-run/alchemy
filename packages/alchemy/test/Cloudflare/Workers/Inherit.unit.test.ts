import {
  assertInheritEnvCollision,
  assertInheritWorkerProps,
  bindingsInheritFor,
  finalizeInheritUploadBindings,
  inheritNamesFromEnv,
  Inherit,
  isInherit,
  WorkerInheritConfigError,
} from "@/Cloudflare/Workers/Inherit.ts";
import { describe, expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

const run = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runSync(Effect.result(effect));

describe("Cloudflare.Workers.Inherit validation", () => {
  test("emits a value-free inherit marker pinned to latest", () => {
    const binding = Inherit("API_TOKEN");
    expect(isInherit(binding)).toBe(true);
    expect(binding.toWorkerBinding()).toEqual({
      type: "inherit",
      name: "API_TOKEN",
      versionId: "latest",
    });
    expect(JSON.stringify(binding.toWorkerBinding())).not.toMatch(
      /text|json|value|secret/i,
    );
  });

  test("finalizeInheritUploadBindings sends strict only for inherit markers", () => {
    expect(bindingsInheritFor(undefined)).toBeUndefined();
    expect(
      Result.getOrThrow(
        run(
          finalizeInheritUploadBindings([{ type: "plain_text", name: "MARK" }]),
        ),
      ),
    ).toBeUndefined();
    expect(
      Result.getOrThrow(
        run(
          finalizeInheritUploadBindings([
            { type: "inherit", name: "API_TOKEN", versionId: "latest" },
          ]),
        ),
      ),
    ).toBe("strict");
  });

  test("rejects unnamed inherit, reserved names, UUID tokens, values, and duplicates", () => {
    const expectFail = (
      bindings: Parameters<typeof finalizeInheritUploadBindings>[0],
      pattern: RegExp,
    ) => {
      const result = run(finalizeInheritUploadBindings(bindings));
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(WorkerInheritConfigError);
        expect(result.failure.message).toMatch(pattern);
      }
    };

    expectFail(
      [{ type: "inherit", name: "", versionId: "latest" }],
      /requires a binding name/,
    );
    expectFail(
      [{ type: "inherit", name: "ALCHEMY_STAGE", versionId: "latest" }],
      /Alchemy-managed/,
    );
    expectFail(
      [{ type: "inherit", name: "VITE_API_TOKEN", versionId: "latest" }],
      /Vite/,
    );
    expectFail(
      [
        {
          type: "inherit",
          name: "API_TOKEN",
          versionId: "693d8201-7c4f-41c6-a187-53c96a699854",
        },
      ],
      /10057/,
    );
    expectFail(
      [
        {
          type: "inherit",
          name: "API_TOKEN",
          versionId: "latest",
          text: "nope",
        },
      ],
      /value-free/,
    );
    expectFail(
      [
        { type: "inherit", name: "API_TOKEN", versionId: "latest" },
        { type: "plain_text", name: "API_TOKEN", text: "x" },
      ],
      /more than once/,
    );
  });

  test("rejects inherit combined with version or a dispatch namespace", () => {
    const names = ["API_TOKEN"];
    const withVersion = run(
      assertInheritWorkerProps({ version: { traffic: 0 } }, names),
    );
    expect(Result.isFailure(withVersion)).toBe(true);
    if (Result.isFailure(withVersion)) {
      expect(withVersion.failure.message).toMatch(/version/);
    }
    const withNamespace = run(
      assertInheritWorkerProps({ namespace: "customers" }, names),
    );
    expect(Result.isFailure(withNamespace)).toBe(true);
    if (Result.isFailure(withNamespace)) {
      expect(withNamespace.failure.message).toMatch(/dispatch/i);
    }
    expect(Result.isSuccess(run(assertInheritWorkerProps({}, names)))).toBe(
      true,
    );
    expect(inheritNamesFromEnv({ API_TOKEN: Inherit() })).toEqual([
      "API_TOKEN",
    ]);
    expect(inheritNamesFromEnv({ MARK: "plain" })).toEqual([]);
  });

  test("rejects inherit vs explicit collision in either direction", () => {
    const inheritThenValue = run(
      assertInheritEnvCollision(
        { type: "inherit", name: "API_TOKEN" },
        "explicit",
      ),
    );
    expect(Result.isFailure(inheritThenValue)).toBe(true);
    if (Result.isFailure(inheritThenValue)) {
      expect(inheritThenValue.failure).toBeInstanceOf(WorkerInheritConfigError);
      expect(inheritThenValue.failure.message).toMatch(
        /inherited and given an explicit value/,
      );
    }

    const valueThenInherit = run(
      assertInheritEnvCollision(
        { type: "plain_text", name: "API_TOKEN" },
        Inherit(),
      ),
    );
    expect(Result.isFailure(valueThenInherit)).toBe(true);
    if (Result.isFailure(valueThenInherit)) {
      expect(valueThenInherit.failure).toBeInstanceOf(WorkerInheritConfigError);
      expect(valueThenInherit.failure.message).toMatch(
        /inherited and given an explicit value/,
      );
    }

    expect(
      Result.isSuccess(
        run(
          assertInheritEnvCollision(
            { type: "inherit", name: "API_TOKEN" },
            Inherit(),
          ),
        ),
      ),
    ).toBe(true);
    expect(
      Result.isSuccess(
        run(
          assertInheritEnvCollision(
            { type: "plain_text", name: "API_TOKEN" },
            "explicit",
          ),
        ),
      ),
    ).toBe(true);
    expect(
      Result.isSuccess(
        run(
          assertInheritEnvCollision(
            { type: "inherit", name: "API_TOKEN" },
            Effect.succeed("runtime"),
          ),
        ),
      ),
    ).toBe(true);
    expect(
      Result.isSuccess(
        run(
          assertInheritEnvCollision(
            { type: "inherit", name: "API_TOKEN" },
            { kind: "Cloudflare.Workers.Inherit", name: "API_TOKEN" },
          ),
        ),
      ),
    ).toBe(true);
  });
});
