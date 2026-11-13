import * as udf from "@distilled.cloud/clickhouse-cloud/udf";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { organizationId as currentOrganizationId } from "../Credentials.ts";
import { ensureAwake, pollUntil } from "../internal/Wait.ts";
import type { Providers } from "../Providers.ts";

export interface AttachmentProps {
  /** SQL name of the function, e.g. a `ClickHouseCloud.Udf.Function`'s `functionName`. Changing it replaces the attachment. */
  functionName: string;
  /** ID of the service, e.g. a `ClickHouseCloud.Service.Service`'s `serviceId`. Changing it replaces the attachment. */
  serviceId: string;
  /**
   * Version to run. Pass the function's `version` attribute so every new
   * version is attached on deploy. Omit to attach the latest ready version
   * once.
   */
  version?: number;
}

export interface AttachmentAttributes {
  /** Organization ID. */
  organizationId: string;
  /** Function name. */
  functionName: string;
  /** Service ID. */
  serviceId: string;
  /** Attached version. */
  version: number;
  /** `deployed` (or `standby` on an idle service) once deploy returns. */
  status: string;
}

export type Attachment = Resource<
  "ClickHouseCloud.Udf.Attachment",
  AttachmentProps,
  AttachmentAttributes,
  never,
  Providers
>;

/**
 * Runs one version of a user-defined function on a service, so SQL on that
 * service can call it. A service runs at most one version of a function;
 * attaching another replaces it.
 *
 * Attaching needs a running service: an idle service is woken first, a
 * stopped one fails the deploy. Deploy returns once the version is
 * `deployed` (or `standby`). Destroying the resource detaches the function
 * and waits until it is gone from the service.
 * @see https://clickhouse.com/docs/cloud/features/user-defined-functions
 *
 * ### Attaching a Function
 * **Example:** Follow every new version
 * ```typescript
 * const analytics = yield* ClickHouseCloud.Service.Service("Analytics", {
 *   provider: "aws",
 *   region: "us-east-1",
 *   ipAccessList: [{ source: "0.0.0.0/0" }],
 * });
 * const fn = yield* ClickHouseCloud.Udf.Function("IsBusinessHours", {
 *   functionName: "isBusinessHours",
 *   source: "./udfs/is_business_hours",
 *   runtime: "python3.11",
 *   arguments: [{ name: "ts", type: "DateTime" }],
 *   returnType: "UInt8",
 * });
 * yield* ClickHouseCloud.Udf.Attachment("IsBusinessHoursOnAnalytics", {
 *   functionName: fn.functionName,
 *   serviceId: analytics.serviceId,
 *   version: fn.version,
 * });
 * // SELECT isBusinessHours(now())
 * ```
 *
 * :::caution
 * Changing `functionName` or `serviceId` replaces the attachment: the
 * function is detached from the old service.
 * :::
 *
 * @resource
 * @product UDF
 */
export const Attachment = Resource<Attachment>("ClickHouseCloud.Udf.Attachment");

const USABLE: Partial<Record<string, true>> = { deployed: true, standby: true };

const toAttributes = (organizationId: string, a: udf.UdfAttachment): AttachmentAttributes => ({
  organizationId,
  functionName: a.functionName,
  serviceId: a.serviceId,
  version: a.version,
  status: a.status,
});

const getAttachment = (organizationId: string, functionName: string, serviceId: string) =>
  udf.getUdfAttachment({ organizationId, functionName, serviceId }).pipe(
    Effect.map((a) => (a.status === "deprovisioning" ? undefined : a)),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

export const AttachmentProvider = () =>
  Provider.effect(
    Attachment,
    Effect.succeed({
      stables: ["organizationId", "functionName", "serviceId"],
      nuke: { dependsOn: ["ClickHouseCloud.Service.Service"] },
      list: () => Effect.succeed([]),
      diff: Effect.fn(function* ({ news, olds }) {
        if (!isResolved(news) || olds === undefined) return undefined;
        if (news.functionName !== olds.functionName || news.serviceId !== olds.serviceId) {
          return { action: "replace" } as const;
        }
        return undefined;
      }),
      read: Effect.fn(function* ({ olds, output }) {
        const organizationId = output?.organizationId ?? (yield* currentOrganizationId);
        const found = yield* getAttachment(
          organizationId,
          output?.functionName ?? olds.functionName,
          output?.serviceId ?? olds.serviceId,
        );
        return found === undefined ? undefined : toAttributes(organizationId, found);
      }),
      reconcile: Effect.fn(function* ({ news, output, session }) {
        const organizationId = output?.organizationId ?? (yield* currentOrganizationId);
        const { functionName, serviceId } = news;
        const wait = pollUntil({
          kind: "UDF attachment",
          id: `${functionName}@${serviceId}`,
          waitingFor: "deployed",
          read: getAttachment(organizationId, functionName, serviceId),
          state: (a) => a?.status,
          done: (a): a is udf.UdfAttachment => a !== undefined && USABLE[a.status] === true,
          failed: (a) =>
            a === undefined
              ? "detached while deploying"
              : a.status === "error"
                ? "deployment failed"
                : undefined,
          session,
          budget: Duration.minutes(20),
          interval: Duration.seconds(10),
        });
        // Observe
        const observed = yield* getAttachment(organizationId, functionName, serviceId);
        if (
          observed !== undefined &&
          (news.version === undefined || observed.version === news.version) &&
          observed.status !== "error"
        ) {
          return toAttributes(organizationId, USABLE[observed.status] ? observed : yield* wait);
        }
        // Ensure + sync: attaching needs a running service.
        yield* ensureAwake({ organizationId, serviceId, session });
        yield* udf.attachUdf({ organizationId, functionName, serviceId, version: news.version });
        return toAttributes(organizationId, yield* wait);
      }),
      delete: Effect.fn(function* ({ output, session }) {
        const { organizationId, functionName, serviceId } = output;
        yield* udf
          .detachUdf({ organizationId, functionName, serviceId })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
        yield* pollUntil({
          kind: "UDF attachment",
          id: `${functionName}@${serviceId}`,
          waitingFor: "detached",
          read: udf
            .getUdfAttachment({ organizationId, functionName, serviceId })
            .pipe(Effect.catchTag("NotFound", () => Effect.undefined)),
          state: (a) => a?.status,
          done: (a): a is undefined => a === undefined,
          session,
          budget: Duration.minutes(20),
          interval: Duration.seconds(10),
        });
      }),
    }),
  );
