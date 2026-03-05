import { Account } from "@/Cloudflare/Account";
import { CloudflareApi } from "@/Cloudflare/CloudflareApi";
import * as KV from "@/Cloudflare/KV/index";
import * as Cloudflare from "@/Cloudflare";
import { destroy } from "@/Destroy";
import { test } from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

test(
  "create and delete namespace with default props",
  Effect.gen(function* () {
    const api = yield* CloudflareApi;
    const accountId = yield* Account;

    yield* destroy();

    const namespace = yield* test.deploy(
      Effect.gen(function* () {
        return yield* KV.Namespace("DefaultNamespace");
      }),
    );

    expect(namespace.title).toBeDefined();
    expect(namespace.namespaceId).toBeDefined();

    const actualNamespace = yield* api.kv.namespaces.get(
      namespace.namespaceId,
      {
        account_id: accountId,
      },
    );
    expect(actualNamespace.id).toEqual(namespace.namespaceId);

    yield* destroy();

    yield* waitForNamespaceToBeDeleted(namespace.namespaceId, accountId);
  }).pipe(Effect.provide(Cloudflare.providers()), logLevel),
);

test(
  "create, update, delete namespace",
  Effect.gen(function* () {
    const api = yield* CloudflareApi;
    const accountId = yield* Account;

    yield* destroy();

    const namespace = yield* test.deploy(
      Effect.gen(function* () {
        return yield* KV.Namespace("TestNamespace", {
          title: "test-namespace-initial",
        });
      }),
    );

    const actualNamespace = yield* api.kv.namespaces.get(
      namespace.namespaceId,
      {
        account_id: accountId,
      },
    );
    expect(actualNamespace.id).toEqual(namespace.namespaceId);
    expect(actualNamespace.title).toEqual(namespace.title);

    // Update the namespace
    const updatedNamespace = yield* test.deploy(
      Effect.gen(function* () {
        return yield* KV.Namespace("TestNamespace", {
          title: "test-namespace-updated",
        });
      }),
    );

    const actualUpdatedNamespace = yield* api.kv.namespaces.get(
      updatedNamespace.namespaceId,
      {
        account_id: accountId,
      },
    );
    expect(actualUpdatedNamespace.title).toEqual("test-namespace-updated");
    expect(actualUpdatedNamespace.id).toEqual(updatedNamespace.namespaceId);

    yield* destroy();

    yield* waitForNamespaceToBeDeleted(namespace.namespaceId, accountId);
  }).pipe(Effect.provide(Cloudflare.providers()), logLevel),
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
