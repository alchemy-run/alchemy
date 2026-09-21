import * as Node from "@distilled.cloud/celld/node";
import {
  ensureBootstrap,
  prepareBootstrap,
  readBootstrap,
} from "@/Celld/Bootstrap.ts";
import {
  prepareDeployment,
  publishApplication,
  stageDeployment,
} from "@/Celld/Deployment.ts";
import { decode, encode } from "@/Celld/Deployment/Objects.ts";
import { BOOTSTRAP_MARKER_KEY } from "@/Celld/Deployment/Publication.ts";
import { describe, expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { makeStore } from "./DeploymentStore.ts";

const props = {
  bucket: { uri: "s3://test-fleet", region: "us-east-1" },
  runtimeVersion: "0.5.0",
};
const app = () =>
  prepareDeployment({
    scriptName: "application",
    mainModule: "index.js",
    modules: [
      {
        name: "index.js",
        content: 'export default { fetch() { return new Response("app"); } };',
      },
    ],
    metadata: { main_module: "index.js", bindings: [] },
    doClasses: [],
    sqliteClasses: [],
  });

describe("Celld startup Bootstrap", () => {
  test.effect(
    "creates a complete empty Worker and operator system classes before the root",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeStore;
        const ready = yield* ensureBootstrap(fake.store, props);
        const manifest = yield* decode(
          Node.Manifest,
          fake.objects.get(`${ready.root.prefix}/manifest.json`)!.body,
        );
        expect(manifest.do_classes).toEqual([
          "__D1Database",
          "__KvNamespace",
          "__Queue",
        ]);
        expect(manifest.sqlite_classes).toEqual(manifest.do_classes);
        expect(manifest.required_features).toEqual([
          "d1-v1",
          "kv-v1",
          "queues-v1",
        ]);
        expect(
          fake.writes.indexOf(`${ready.root.prefix}/manifest.json`),
        ).toBeLessThan(fake.writes.indexOf("deploy/current.json"));
        expect(ready.ready).toBe(true);
        expect(yield* readBootstrap(fake.store, props)).toEqual(ready);
        const writes = fake.writes.length;
        yield* ensureBootstrap(fake.store, props);
        expect(fake.writes.length).toBe(writes);
      }),
  );

  test.effect(
    "preserves an existing application root byte-for-byte and marks startup ready",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeStore;
        const prepared = yield* app();
        yield* stageDeployment(fake.store, prepared);
        const root = yield* fake.store.put(
          "deploy/current.json",
          yield* encode(prepared.pointer),
        );
        const ready = yield* ensureBootstrap(fake.store, props);
        expect(ready.root).toEqual(prepared.pointer);
        expect(fake.objects.get("deploy/current.json")!.etag).toBe(root.etag);
        expect(fake.objects.has(BOOTSTRAP_MARKER_KEY)).toBe(true);
      }),
  );

  test.effect(
    "preserves a competing application root during first initialization",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeStore;
        const prepared = yield* app();
        yield* stageDeployment(fake.store, prepared);
        const body = yield* encode(prepared.pointer);
        fake.race.set("deploy/current.json", () =>
          fake.objects.set("deploy/current.json", {
            body,
            etag: "competing-app",
          }),
        );
        const ready = yield* ensureBootstrap(fake.store, props);
        expect(ready.root).toEqual(prepared.pointer);
        expect(fake.objects.get("deploy/current.json")!.etag).toBe(
          "competing-app",
        );
      }),
  );

  test.effect(
    "recognizes the bootstrap marker for first Application ownership without adopt",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeStore;
        const bootstrap = yield* ensureBootstrap(fake.store, props);
        const prepared = yield* app();
        const publication = yield* publishApplication(fake.store, {
          rootPreparedDeployment: prepared,
          workers: [],
          owner: {
            stack: "Test",
            stage: "test",
            fqn: "App",
            instanceId: "one",
          },
          transactionId: "first",
        });
        expect(publication.previous).toEqual([bootstrap.root]);
        expect((yield* ensureBootstrap(fake.store, props)).root).toEqual(
          prepared.pointer,
        );
      }),
  );

  test.effect(
    "refuses unsupported runtime migrations, altered descriptors and corrupt roots",
    () =>
      Effect.gen(function* () {
        for (const runtimeVersion of ["0.1.0", "0.4.0", "0.6.0", "latest"])
          expect(
            Result.isFailure(
              yield* Effect.result(
                prepareBootstrap({ ...props, runtimeVersion }),
              ),
            ),
          ).toBe(true);
        const fake = yield* makeStore;
        yield* ensureBootstrap(fake.store, props);
        expect(
          Result.isFailure(
            yield* Effect.result(
              readBootstrap(fake.store, {
                ...props,
                bucket: { uri: "s3://other" },
              }),
            ),
          ),
        ).toBe(true);
        yield* fake.store.put(
          "deploy/current.json",
          yield* encode({
            version: "legacy",
            prefix: "deploy/legacy",
            rollout: { percent: 100 },
          }),
        );
        expect(
          Result.isFailure(
            yield* Effect.result(ensureBootstrap(fake.store, props)),
          ),
        ).toBe(true);
        expect(
          (yield* decode(
            Node.DeployPointer,
            fake.objects.get("deploy/current.json")!.body,
          )).version,
        ).toBe("legacy");
      }),
  );

  test.effect(
    "does not report ready from a descriptor when the root module is missing",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeStore;
        const ready = yield* ensureBootstrap(fake.store, props);
        yield* fake.store.delete(`${ready.root.prefix}/index.js`);
        expect(
          Result.isFailure(
            yield* Effect.result(readBootstrap(fake.store, props)),
          ),
        ).toBe(true);
      }),
  );
});
