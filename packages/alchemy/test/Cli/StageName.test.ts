import { createDefaultStageName } from "@/Cli/StageName.ts";
import { describe, expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";

describe("createDefaultStageName", () => {
  test.effect("keeps an already normalized user name readable", () =>
    Effect.gen(function* () {
      expect(yield* createDefaultStageName("user")).toBe("dev-user");
      expect(yield* createDefaultStageName("123user")).toBe("dev-123user");
    }),
  );

  test.effect("gives normalized user names stable, distinct identities", () =>
    Effect.gen(function* () {
      expect(yield* createDefaultStageName("User Name")).toBe(
        "dev-user-name-vfu5at",
      );
      expect(yield* createDefaultStageName("user_name")).toBe(
        "dev-user-name-fygq4a",
      );
    }),
  );

  test.effect("uses only the hash when the user name has no slug", () =>
    Effect.gen(function* () {
      expect(yield* createDefaultStageName("___")).toBe("dev-xwrfcv");
    }),
  );

  test.effect("hashes only after the default stage length limit", () =>
    Effect.gen(function* () {
      expect(yield* createDefaultStageName("a".repeat(28))).toBe(
        `dev-${"a".repeat(28)}`,
      );
      expect(yield* createDefaultStageName("a".repeat(29))).toBe(
        `dev-${"a".repeat(21)}-nej4tr`,
      );
    }),
  );

  test.effect(
    "distinguishes long user names with the same truncated slug",
    () =>
      Effect.gen(function* () {
        expect(yield* createDefaultStageName(`user-${"a".repeat(60)}`)).toBe(
          `dev-user-${"a".repeat(16)}-rvgpjw`,
        );
        expect(yield* createDefaultStageName(`user_${"a".repeat(60)}`)).toBe(
          `dev-user-${"a".repeat(16)}-wyjsu6`,
        );
      }),
  );
});
