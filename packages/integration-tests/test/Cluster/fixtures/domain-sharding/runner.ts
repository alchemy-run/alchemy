/**
 * A plain Bun process that hosts the Domain conformance model on its own
 * Effect Cluster runner, with `DomainCluster.layerSharding`, and serves the
 * conformance routes. No pool, gateway or Bootstrap resource.
 *
 * Env: `DATABASE_URL`, `RUNNER_PORT`, `FRONT_PORT`, `RUNNER_NAME` (its
 * Postgres application name).
 */
import * as DomainCluster from "@alchemy.run/domain/EffectCluster";
import { BunClusterHttp, BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { PgClient } from "@effect/sql-pg";
import { ClusterWorkflowEngine, RunnerAddress } from "effect/cluster";
import * as Effect from "effect/Effect";
import * as HttpServer from "effect/http/HttpServer";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { app } from "../../../Domain/conformance/app.ts";
import { ConformanceLive } from "../../../Domain/conformance/model.ts";

const Cluster = ClusterWorkflowEngine.layer.pipe(
  Layer.provideMerge(
    BunClusterHttp.layer({
      transport: "http",
      storage: "sql",
      shardingConfig: {
        runnerAddress: Option.some(
          RunnerAddress.make("127.0.0.1", Number(process.env.RUNNER_PORT)),
        ),
      },
    }),
  ),
  Layer.provideMerge(
    PgClient.layer({
      url: Redacted.make(process.env.DATABASE_URL ?? ""),
      applicationName: process.env.RUNNER_NAME,
    }),
  ),
);

const Model = ConformanceLive.pipe(
  Layer.provide(DomainCluster.layerSharding({ name: "DomainSharding" })),
);

const Front = Layer.unwrap(Effect.map(app, (fetch) => HttpServer.serve()(fetch))).pipe(
  Layer.provide(Model),
  Layer.provide(BunHttpServer.layer({ port: Number(process.env.FRONT_PORT) })),
);

Layer.launch(Front.pipe(Layer.provide(Cluster))).pipe(BunRuntime.runMain);
