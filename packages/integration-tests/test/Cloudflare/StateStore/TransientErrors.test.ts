import { EdgeSessionError } from "@alchemy.run/cloudflare/EdgeSession";
import {
  isTransientEdgeSessionError,
  keepCredentialRejection,
} from "@alchemy.run/cloudflare/StateStore/State";
import { describe, expect, it } from "@alchemy.run/test";
import { fromApiToken } from "@distilled.cloud/cloudflare/Credentials";
import * as workers from "@distilled.cloud/cloudflare/workers";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";

/**
 * Predicate coverage for the edge-preview secret-read retry policy, added in
 * response to production failures (Axiom `prod-traces`): reads failing with
 * Cloudflare HTML error pages ("Secret probe returned 400/502:
 * <!DOCTYPE html>..."), session creation flakes and transport errors
 * ("fetch failed").
 */
describe(
  "isTransientEdgeSessionError",
  { tags: ["unit", "provider:cloudflare", "provider:cloudflare:statestore", "local"] },
  () => {
    it("retries non-200 secret-probe responses (Cloudflare HTML error pages)", () => {
      const error = new EdgeSessionError({
        message: 'Secret probe returned 400: <!DOCTYPE html>\n<html class="no-',
      });
      expect(isTransientEdgeSessionError(error)).toBe(true);
    });

    it("retries session-creation failures with transient causes", () => {
      const error = new EdgeSessionError({
        message: "Failed to create edge preview session",
        cause: new TypeError("fetch failed"),
      });
      expect(isTransientEdgeSessionError(error)).toBe(true);
    });

    it("does not retry permanent auth causes", () => {
      for (const tag of ["Unauthorized", "Forbidden", "InvalidRoute"]) {
        const cause = Object.assign(new Error("denied"), { _tag: tag });
        const error = new EdgeSessionError({
          message: "Failed to create edge preview session",
          cause,
        });
        expect(isTransientEdgeSessionError(error)).toBe(false);
      }
    });

    it("ignores non-EdgeSessionError values", () => {
      expect(isTransientEdgeSessionError(new Error("boom"))).toBe(false);
    });
  },
);

const reply = (status: number, code: number, message: string) => () =>
  Response.json(
    { success: false, errors: [{ code, message }], messages: [], result: null },
    { status },
  );
const rejected = reply(401, 10000, "Authentication error");
const rateLimited = reply(
  429,
  10429,
  "Rate limited. Please wait and consider throttling your request speed",
);
const found = () =>
  Response.json({ success: true, errors: [], messages: [], result: { subdomain: "example" } });

/** Look up the subdomain against Cloudflare answering with `replies` in order, the last one repeating. */
const lookupSubdomain = (replies: ReadonlyArray<() => Response>) =>
  Effect.gen(function* () {
    let calls = 0;
    const stub = async (_input: Parameters<typeof fetch>[0]) =>
      replies[Math.min(calls++, replies.length - 1)]!();
    const fiber = yield* workers
      .getSubdomain({ accountId: "0".repeat(32) })
      .pipe(
        keepCredentialRejection,
        Effect.provide(
          Layer.mergeAll(
            fromApiToken({ apiToken: Redacted.make("made-up") }),
            FetchHttpClient.layer.pipe(
              Layer.provide(Layer.succeed(FetchHttpClient.Fetch, stub as typeof globalThis.fetch)),
            ),
          ),
        ),
        Effect.result,
        Effect.forkChild,
      );
    yield* TestClock.adjust("2 minutes");
    return { result: yield* Fiber.join(fiber), calls: () => calls };
  });

describe(
  "keepCredentialRejection",
  { tags: ["unit", "provider:cloudflare", "provider:cloudflare:statestore", "local"] },
  () => {
    it.effect("a credential Cloudflare keeps rejecting fails as the rejection", () =>
      Effect.gen(function* () {
        // Cloudflare rate limits a credential it has rejected four times.
        const { result } = yield* lookupSubdomain([
          rejected,
          rejected,
          rejected,
          rejected,
          rateLimited,
        ]);
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "Unauthorized", message: "Authentication error" },
        });
      }),
    );

    it.effect("a valid token rejected for a moment is retried and succeeds", () =>
      Effect.gen(function* () {
        const { result, calls } = yield* lookupSubdomain([rejected, rejected, rejected, found]);
        expect(result).toMatchObject({ _tag: "Success", success: { subdomain: "example" } });
        expect(calls()).toBe(4);
      }),
    );

    it.effect("a rate limit with no rejection before it stays a rate limit", () =>
      Effect.gen(function* () {
        const { result } = yield* lookupSubdomain([rateLimited]);
        expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "TooManyRequests" } });
      }),
    );
  },
);
