/** An existing Effect Cluster program, written without Alchemy and run as it is. */
import { NodeClusterHttp, NodeRuntime } from "@effect/platform-node";
import { PgClient } from "@effect/sql-pg";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { Tally } from "./tally.ts";

const TallyLive = Tally.toLayer(
  Effect.gen(function* () {
    const total = yield* Ref.make(0);
    return Tally.of({
      Add: ({ payload }) => Ref.updateAndGet(total, (n) => n + payload.amount),
    });
  }),
);

const Sql = PgClient.layerConfig({ url: Config.Redacted("DATABASE_URL") });

Layer.launch(
  TallyLive.pipe(
    Layer.provide(NodeClusterHttp.layer({ transport: "http", storage: "sql" })),
    Layer.provide(Sql),
  ),
).pipe(NodeRuntime.runMain);
