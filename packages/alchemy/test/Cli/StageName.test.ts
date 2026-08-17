import { defaultStageName } from "@/Cli/StageName.ts";
import { describe, expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

describe("default stage names", () => {
  test.effect("uses a hostname-safe user name", () =>
    Effect.gen(function* () {
      expect(yield* defaultStageName("user")).toBe("dev-user");
      expect(yield* defaultStageName("123user")).toBe("dev-123user");
    }),
  );

  test.effect("maps unsafe user names to stable, distinct names", () =>
    Effect.gen(function* () {
      const spaced = yield* defaultStageName("User Name");
      const underscored = yield* defaultStageName("user_name");

      expect(spaced).toMatch(/^dev-user-name-[a-z2-7]{8}$/);
      expect(underscored).toMatch(/^dev-user-name-[a-z2-7]{8}$/);
      expect(spaced).not.toBe(underscored);
      expect(yield* defaultStageName("User Name")).toBe(spaced);
    }),
  );

  test.effect("stays within the hostname label limit", () =>
    Effect.gen(function* () {
      const long = yield* defaultStageName("a".repeat(100));
      const invalid = yield* defaultStageName("___");

      expect(long).toHaveLength(63);
      expect(invalid).toMatch(/^dev-user-[a-z2-7]{8}$/);
    }),
  );

  test.effect("requires a user name", () =>
    Effect.gen(function* () {
      for (const user of [undefined, ""]) {
        const result = yield* Effect.result(defaultStageName(user));

        expect(Result.isFailure(result)).toBe(true);
      }
    }),
  );
});
