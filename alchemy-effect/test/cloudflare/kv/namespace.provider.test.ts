import { CloudflareAccountId, CloudflareApi } from "@/cloudflare/api";
import * as KV from "@/cloudflare/kv";
import * as CloudflareLive from "@/cloudflare/live";
import { apply, destroy } from "@/index";
import { test } from "@/test";
import { expect } from "@effect/vitest";
import { LogLevel } from "effect";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Schedule from "effect/Schedule";

const logLevel = Logger.withMinimumLogLevel(
  process.env.DEBUG ? LogLevel.Debug : LogLevel.Info,
);

test(
  "create, update, delete namespace",
  Effect.gen(function* () {
    const api = yield* CloudflareApi;
    const accountId = yield* CloudflareAccountId;

    {
      class TestNamespace extends KV.Namespace("TestNamespace", {
        title: "test-namespace-initial",
      }) {}

      const stack = yield* apply(TestNamespace);

      const actualNamespace = yield* api.kv.namespaces.get(
        stack.TestNamespace.namespaceId,
        {
          account_id: accountId,
        },
      );
      expect(actualNamespace.id).toEqual(stack.TestNamespace.namespaceId);
      expect(actualNamespace.title).toEqual(stack.TestNamespace.title);
    }

    class TestNamespace extends KV.Namespace("TestNamespace", {
      title: "test-namespace-updated",
    }) {}

    const stack = yield* apply(TestNamespace);

    const actualNamespace = yield* api.kv.namespaces.get(
      stack.TestNamespace.namespaceId,
      {
        account_id: accountId,
      },
    );
    expect(actualNamespace.title).toEqual("test-namespace-updated");
    expect(actualNamespace.id).toEqual(stack.TestNamespace.namespaceId);

    yield* destroy();

    yield* waitForNamespaceToBeDeleted(
      stack.TestNamespace.namespaceId,
      accountId,
    );
  }).pipe(Effect.provide(CloudflareLive.live()), logLevel),
);

const waitForNamespaceToBeDeleted = Effect.fn(function* (
  namespaceId: string,
  accountId: string,
) {
  const api = yield* CloudflareApi;
  yield* api.kv.namespaces
    .get(namespaceId, {
      account_id: accountId,
    })
    .pipe(
      Effect.flatMap(() => Effect.fail(new NamespaceStillExists())),
      Effect.retry({
        while: (e): e is NamespaceStillExists =>
          e instanceof NamespaceStillExists,
        schedule: Schedule.exponential(100),
      }),
      Effect.catchTag("NotFound", () => Effect.void),
    );
});

class NamespaceStillExists extends Data.TaggedError("NamespaceStillExists") {}
