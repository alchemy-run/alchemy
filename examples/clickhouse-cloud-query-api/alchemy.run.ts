// alchemy.run.ts
import * as ClickHouseCloud from "@alchemy.run/clickhouse-cloud";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import Api from "./src/Api.ts";
import { Analytics } from "./src/Data.ts";

export default Alchemy.Stack(
  "ClickHouseCloudQueryApi",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), ClickHouseCloud.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const analytics = yield* Analytics;
    const api = yield* Api;
    return { url: api.url.as<string>(), serviceId: analytics.serviceId };
  }),
);
