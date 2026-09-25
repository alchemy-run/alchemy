import * as Kubernetes from "@/Kubernetes";
import { KubernetesApiError } from "@/Kubernetes/internal/client.ts";
import * as Provider from "@/Provider";
import type { ScopedPlanStatusSession } from "@/Report.ts";
import { inMemoryState } from "@/State";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as https from "node:https";
import type { AddressInfo } from "node:net";
import { LOCALHOST_CERT, LOCALHOST_KEY } from "./fixtures/tls.ts";

const { test } = Test.make({
  providers: Kubernetes.providers(),
  state: inMemoryState(),
});

const tags = ["provider:kubernetes", "provider:kubernetes:manifest", "local"];

const manifest = {
  apiVersion: "v1",
  kind: "ConfigMap",
  metadata: { name: "app-config", namespace: "default" },
  data: { LOG_LEVEL: "info" },
};

const diffCluster = (
  olds: Kubernetes.Connection,
  news: Kubernetes.Connection,
) =>
  Effect.gen(function* () {
    const provider = yield* Provider.findProvider(Kubernetes.Manifest);
    return yield* provider.diff!({
      id: "AppConfig",
      fqn: "AppConfig",
      instanceId: "instance",
      olds: { cluster: olds, manifest },
      news: { cluster: news, manifest },
      oldBindings: [],
      newBindings: [],
      output: undefined,
    });
  });

const endpoint = "https://10.0.0.1:6443";

test.provider(
  "rotating credentials against the same endpoint does not replace",
  () =>
    Effect.gen(function* () {
      // A replacement deletes the old generation by its object ref, which is
      // the same name/namespace — so a credential rotation planned as a
      // replace deletes the live object after a green deploy.
      const rotations: [Kubernetes.Connection, Kubernetes.Connection][] = [
        [
          { endpoint, auth: { kind: "token", token: "token-a" } },
          { endpoint, auth: { kind: "token", token: "token-b" } },
        ],
        [
          {
            endpoint,
            auth: { kind: "client-cert", certificate: "cert-a", key: "key-a" },
          },
          {
            endpoint,
            auth: { kind: "client-cert", certificate: "cert-b", key: "key-b" },
          },
        ],
        [
          { endpoint, auth: { kind: "exec", command: "mint", args: ["a"] } },
          { endpoint, auth: { kind: "exec", command: "mint", args: ["b"] } },
        ],
      ];
      for (const [olds, news] of rotations) {
        const diff = yield* diffCluster(olds, news);
        expect(diff?.action).not.toBe("replace");
      }
    }),
  { tags },
);

test.provider(
  "moving to a different endpoint replaces",
  () =>
    Effect.gen(function* () {
      const diff = yield* diffCluster(
        { endpoint, auth: { kind: "token", token: "token-a" } },
        {
          endpoint: "https://10.0.0.2:6443",
          auth: { kind: "token", token: "token-a" },
        },
      );
      expect(diff).toEqual({ action: "replace" });
    }),
  { tags },
);

/**
 * A fake API server that answers every request with `status` and records
 * what it received.
 */
const fakeApiServer = (status: number) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const requests: string[] = [];
      const server = https.createServer(
        { cert: LOCALHOST_CERT, key: LOCALHOST_KEY },
        (req, res) => {
          requests.push(`${req.method} ${req.url}`);
          res.statusCode = status;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ kind: "Status", code: status }));
        },
      );
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", () => resolve()),
      );
      const { port } = server.address() as AddressInfo;
      return { server, requests, endpoint: `https://127.0.0.1:${port}` };
    }),
    ({ server }) =>
      Effect.promise(
        () => new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );

const deleteAgainst = (serverEndpoint: string) =>
  Effect.gen(function* () {
    const provider = yield* Provider.findProvider(Kubernetes.Manifest);
    const connection: Kubernetes.Connection = {
      endpoint: serverEndpoint,
      certificateAuthorityData: Buffer.from(LOCALHOST_CERT).toString("base64"),
      auth: { kind: "token", token: "token-a" },
    };
    const ref = {
      apiVersion: "v1",
      kind: "ConfigMap",
      name: "app-config",
      namespace: "default",
    };
    return yield* provider.delete({
      id: "AppConfig",
      fqn: "AppConfig",
      instanceId: "instance",
      olds: { cluster: connection, manifest },
      output: { connection, ...ref, ref, uid: "uid-1" },
      session: {
        note: () => Effect.void,
      } as unknown as ScopedPlanStatusSession,
      bindings: [],
    });
  });

test.provider(
  "delete treats an already-gone object (404) as deleted",
  () =>
    Effect.gen(function* () {
      const fake = yield* fakeApiServer(404);
      yield* deleteAgainst(fake.endpoint);
      expect(fake.requests).toEqual([
        "DELETE /api/v1/namespaces/default/configmaps/app-config",
      ]);
    }).pipe(Effect.scoped),
  { tags },
);

test.provider(
  "delete surfaces a rejected delete (403) instead of dropping state",
  () =>
    Effect.gen(function* () {
      const fake = yield* fakeApiServer(403);
      const result = yield* Effect.result(deleteAgainst(fake.endpoint));
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(KubernetesApiError);
        expect(result.failure).toMatchObject({
          method: "DELETE",
          statusCode: 403,
        });
      }
    }).pipe(Effect.scoped),
  { tags },
);
