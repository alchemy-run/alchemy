/**
 * One small service the service-scoped suites can share instead of each
 * creating (and paying for) their own. The trial organization allows two
 * services, so a run of every suite against a shared service fits next to
 * the organization's own service.
 *
 * ```sh
 * alchemy deploy test/ClickHouseCloud/fixtures/shared-service.run.ts --stage shared
 * CLICKHOUSE_CLOUD_TEST_SERVICE_ID=<serviceId> pnpm test:integration test/ClickHouseCloud/...
 * alchemy destroy test/ClickHouseCloud/fixtures/shared-service.run.ts --stage shared
 * ```
 */
import * as ClickHouseCloud from "@alchemy.run/clickhouse-cloud";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { small } from "./resources.ts";

export default Alchemy.Stack(
  "ClickHouseCloudSharedService",
  { providers: ClickHouseCloud.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const shared = yield* ClickHouseCloud.Service.Service("Shared", {
      ...small,
      ipAccessList: [{ source: "0.0.0.0/0", description: "shared test service" }],
    });
    return { serviceId: shared.serviceId, httpsUrl: shared.httpsUrl };
  }),
);
