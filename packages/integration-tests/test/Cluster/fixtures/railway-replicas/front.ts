/**
 * The replicas suite's front: a public Railway Service in the cluster's
 * environment. It calls the replica entity through the pool's gateway, and
 * asks one runner, at its own private address, to crash: only for a caller
 * with the suite's `TEST_RAILWAY_CRASH_KEY`, and never without one.
 */
import * as Railway from "@alchemy.run/railway";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Partition, Site } from "../../../Railway/fixtures/suite-env.ts";
import { CRASH_PORT } from "./replica-live.ts";
import { Replicas } from "./replica.ts";

export default class ReplicasFront extends Railway.Service<ReplicasFront>()(
  "ClusterReplicasFront",
  {
    project: Site,
    environment: Partition,
    main: import.meta.url,
    port: 3000,
    healthcheck: "/ready",
    env: { TEST_RAILWAY_CRASH_KEY: process.env.TEST_RAILWAY_CRASH_KEY ?? "" },
  },
  Effect.gen(function* () {
    const replicas = yield* Replicas;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const [route, id = "x", tx, amount] = new URL(request.url, "http://front").pathname
          .split("/")
          .filter((part) => part.length > 0);
        switch (route) {
          case "ready":
            // JSON: the suite reads every route of the front as JSON.
            return yield* HttpServerResponse.json("ok");
          case "where":
            return yield* HttpServerResponse.json(yield* (yield* replicas.getByName(id)).Where());
          case "credit":
            return yield* HttpServerResponse.json({
              value: yield* (yield* replicas.getByName(id)).Credit({
                txId: tx!,
                amount: Number(amount),
              }),
            });
          case "crash": {
            const key = yield* Config.String("TEST_RAILWAY_CRASH_KEY").pipe(Config.withDefault(""));
            // `id` is a replica's own address, as `where` reported it.
            if (
              key === "" ||
              request.headers.authorization !== `Bearer ${key}` ||
              !/^[0-9a-f:]+$/i.test(id)
            ) {
              return HttpServerResponse.empty({ status: 404 });
            }
            const response = yield* HttpClient.post(`http://[${id}]:${CRASH_PORT}/crash`).pipe(
              Effect.provide(FetchHttpClient.layer),
            );
            return yield* HttpServerResponse.json(response.status, {
              status: response.status === 200 ? 200 : 502,
            });
          }
          default:
            return HttpServerResponse.empty({ status: 404 });
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed(HttpServerResponse.text(String(cause), { status: 500 })),
        ),
      ),
    };
  }),
) {}
