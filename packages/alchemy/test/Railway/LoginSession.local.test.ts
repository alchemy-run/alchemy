import { GqlTransport } from "@distilled.cloud/railway";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import { pollLoginSessionToken } from "@/Railway/LoginSession.ts";

const authorizedSession = Layer.succeed(GqlTransport, {
  execute: (request) =>
    Effect.succeed({
      data: Object.fromEntries(
        [...request.tree.children.values()].map((child) => [
          child.alias ?? child.field,
          child.field === "loginSessionConsume" ? "railway-token" : true,
        ]),
      ),
    }),
});

describe("Railway login session", { tags: ["unit", "provider:railway", "local"] }, () => {
  it.effect("returns the token of an authorized session, still redacted", () =>
    Effect.gen(function* () {
      const fiber = yield* pollLoginSessionToken("code").pipe(
        Effect.provide(authorizedSession),
        Effect.forkChild({ startImmediately: true }),
      );

      yield* TestClock.adjust("301 seconds");
      const token = yield* Fiber.join(fiber);
      expect(Redacted.isRedacted(token)).toBe(true);
      expect(token !== undefined && Redacted.value(token)).toBe("railway-token");
    }),
  );
});
