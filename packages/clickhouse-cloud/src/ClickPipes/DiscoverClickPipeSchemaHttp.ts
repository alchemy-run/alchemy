import * as pipes from "@distilled.cloud/clickhouse-cloud/click_pipes";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { BindService } from "../ClickHouseCloudBindings.ts";
import type { Service } from "../Service/Service.ts";
import { DiscoverClickPipeSchema } from "./DiscoverClickPipeSchema.ts";

/** {@link DiscoverClickPipeSchema} over the ClickHouse Cloud API; works on any host. */
export const DiscoverClickPipeSchemaHttp = Layer.effect(
  DiscoverClickPipeSchema,
  Effect.gen(function* () {
    const bind = yield* BindService;
    return Effect.fn(function* (target: Service) {
      const run = yield* bind("DiscoverClickPipeSchema", target, [
        "control-plane:service:view",
        "control-plane:service:manage-clickpipes",
        // ClickPipes answers "No database access to use ClickPipes" without it.
        "sql-console:database:access",
      ]);
      return (source: pipes.ClickPipeSchemaDiscoverySource) =>
        run((ids) => pipes.discoverClickPipeSchema({ ...ids, source }));
    });
  }),
);
