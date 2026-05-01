import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as KV from "@/Cloudflare/KV/index";
import * as Test from "@/Test/Vitest";
import * as kv from "@distilled.cloud/cloudflare/kv";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

test.provider("create and delete namespace with default props", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;

    yield* stack.destroy();

    const namespace = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* KV.KVNamespace("DefaultNamespace");
      }),
    );

    expect(namespace.title).toBeDefined();
    expect(namespace.namespaceId).toBeDefined();

    const actualNamespace = yield* kv.getNamespace({
      accountId,
      namespaceId: namespace.namespaceId,
    });
    expect(actualNamespace.id).toEqual(namespace.namespaceId);

    yield* stack.destroy();

    yield* waitForNamespaceToBeDeleted(namespace.namespaceId, accountId);
  }).pipe(logLevel),
);

test.provider("create, update, delete namespace", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;

    yield* stack.destroy();

    const namespace = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* KV.KVNamespace("TestNamespace", {
          title: "test-namespace-initial",
        });
      }),
    );

    const actualNamespace = yield* kv.getNamespace({
      accountId,
      namespaceId: namespace.namespaceId,
    });
    expect(actualNamespace.id).toEqual(namespace.namespaceId);
    expect(actualNamespace.title).toEqual(namespace.title);

    const updatedNamespace = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* KV.KVNamespace("TestNamespace", {
          title: "test-namespace-updated",
        });
      }),
    );

    const actualUpdatedNamespace = yield* kv.getNamespace({
      accountId,
      namespaceId: updatedNamespace.namespaceId,
    });
    expect(actualUpdatedNamespace.title).toEqual("test-namespace-updated");
    expect(actualUpdatedNamespace.id).toEqual(updatedNamespace.namespaceId);

    yield* stack.destroy();

    yield* waitForNamespaceToBeDeleted(namespace.namespaceId, accountId);
  }).pipe(logLevel),
);

const waitForNamespaceToBeDeleted = Effect.fn(function* (
  namespaceId: string,
  accountId: string,
) {
  yield* kv
    .getNamespace({
      accountId,
      namespaceId,
    })
    .pipe(
      Effect.flatMap(() => Effect.fail(new NamespaceStillExists())),
      Effect.retry({
        while: (e): e is NamespaceStillExists =>
          e instanceof NamespaceStillExists,
        schedule: Schedule.exponential(100),
      }),
      Effect.catchTag("NamespaceNotFound", () => Effect.void),
    );
});

class NamespaceStillExists extends Data.TaggedError("NamespaceStillExists") {}
