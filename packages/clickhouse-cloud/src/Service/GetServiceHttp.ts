import * as service from "@distilled.cloud/clickhouse-cloud/service";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { BindService } from "../ClickHouseCloudBindings.ts";
import { GetService } from "./GetService.ts";
import type { Service } from "./Service.ts";

/** {@link GetService} over the ClickHouse Cloud API; works on any host. */
export const GetServiceHttp = Layer.effect(
  GetService,
  Effect.gen(function* () {
    const bind = yield* BindService;
    return Effect.fn(function* (target: Service) {
      const run = yield* bind("GetService", target, ["control-plane:service:view"]);
      return () => run((ids) => service.getService(ids));
    });
  }),
);
