import * as ClickHouseCloud from "@alchemy.run/clickhouse-cloud";
import * as Effect from "effect/Effect";
import { small } from "./resources.ts";

/**
 * A service deployed by `shared-service.run.ts` that the child-resource
 * suites reuse instead of each creating (and paying for) their own. The
 * trial organization allows two services, so the suites run one at a time
 * against it next to the organization's own service.
 */
export const sharedServiceId = process.env.CLICKHOUSE_CLOUD_TEST_SERVICE_ID;

/** Child-resource suites need a service: the shared one, or a small one each (slow). */
export const needsService =
  sharedServiceId === undefined && !process.env.CLICKHOUSE_CLOUD_TEST_SLOW;

/**
 * The service a child resource attaches to inside a test stack: the shared
 * service, or a small service the stack creates and destroys itself.
 */
export const testServiceId = Effect.gen(function* () {
  if (sharedServiceId !== undefined) return sharedServiceId;
  const svc = yield* ClickHouseCloud.Service.Service("TestService", {
    ...small,
    ipAccessList: [{ source: "0.0.0.0/0", description: "child resource test" }],
  });
  return svc.serviceId;
});
