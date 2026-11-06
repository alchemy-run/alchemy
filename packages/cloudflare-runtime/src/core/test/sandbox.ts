/// <reference types="node" />

import * as Credentials from "@distilled.cloud/cloudflare/Credentials";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import { KvNamespace } from "../../../dist/core/node/bindings/index.mjs";
import * as WorkerProxy from "../../../dist/core/node/proxy/WorkerProxy.mjs";
import * as Runtime from "../../../dist/core/node/Runtime.mjs";
import * as RuntimeServices from "../../../dist/core/node/RuntimeServices.mjs";

const main = Effect.gen(function* () {
  const runtime = yield* Runtime.Runtime;
  const workerProxy = yield* WorkerProxy.WorkerProxy;
  const proxyInstance = yield* workerProxy.serve({ port: 0 });
  const upstreamUrl = yield* runtime.start({
    name: "test",
    compatibilityDate: "2026-01-01",
    compatibilityFlags: [],
    bindings: [KvNamespace.remote("TEST", "ff74cfc28c744cdfb77664ff07050b13")],
    modules: [
      {
        name: "test.js",
        type: "ESModule",
        content: `export default { fetch: async (request, env) => {
          const list = await env.TEST.list();
            return Response.json(list);
          } }`,
      },
    ],
  });
  yield* proxyInstance.set(upstreamUrl);
  yield* Effect.log(proxyInstance.url.href);
  const response = yield* HttpClient.get(new URL("/", proxyInstance.url)).pipe(Effect.orDie);
  const res = {
    status: response.status,
    body: yield* response.text.pipe(Effect.orDie),
  };
  yield* Effect.log(res);
  return res;
});

const services = RuntimeServices.layerRuntime({
  api: { accountId: process.env.CLOUDFLARE_ACCOUNT_ID! },
}).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      Credentials.fromEnv(),
      NodeServices.layer,
      FetchHttpClient.layer,
      SecureRandom.layerWebCrypto,
    ),
  ),
);

await main.pipe(Effect.provide(services), Effect.scoped, Effect.runPromise);
