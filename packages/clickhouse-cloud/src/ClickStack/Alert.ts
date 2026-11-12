import * as stack from "@distilled.cloud/clickhouse-cloud/click_stack";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { organizationId as currentOrganizationId } from "../Credentials.ts";
import { ResultMissing, requireResult } from "../Errors.ts";
import type { Providers } from "../Providers.ts";
import { type ClickStackScope, covers } from "./internal.ts";

export type AlertProps = ClickStackScope &
  Omit<stack.CreateClickStackAlertRequest, "organizationId" | "serviceId">;

export interface AlertAttributes {
  /** ID of the alert. */
  id: string;
  /** Service ID. */
  serviceId: string;
  /** Organization ID. */
  organizationId: string;
  /** The object as ClickStack stores it. */
  observed: stack.ClickStackAlertResponse;
}

/** What an event source adds to an alert: webhooks that notify its host. */
export interface AlertBinding {
  webhookIds: string[];
}

export type Alert = Resource<
  "ClickHouseCloud.ClickStack.Alert",
  AlertProps,
  AlertAttributes,
  AlertBinding,
  Providers
>;

/**
 * A ClickStack alert: a threshold or anomaly check over a saved search, a
 * dashboard tile or an inline chart, evaluated every `interval`, notifying
 * up to ten channels (emails or webhooks).
 *
 * ClickStack is in public beta and must be set up for the service in the
 * console before its API answers. Updates send the whole object (PUT), so
 * the props are the full definition. `state` (`ALERT`, `OK`, `PENDING`, …) is runtime data: read it with the
 * `GetClickStackAlert` and `ListClickStackAlerts` bindings.
 * Objects in ClickStack carry no alchemy marker, so only those in state
 * are managed. Needs `control-plane:service:manage-clickstack-api`.
 * @see https://clickhouse.com/docs/use-cases/observability/clickstack
 *
 * ### Creating a Alert
 * **Example:** In the service's ClickStack
 * ```typescript
 * const oncall = yield* ClickHouseCloud.ClickStack.Webhook("Oncall", {
 *   serviceId: analytics.serviceId,
 *   name: "oncall",
 *   service: "slack",
 *   url: yield* Config.redacted("SLACK_WEBHOOK_URL"),
 * });
 * yield* ClickHouseCloud.ClickStack.Alert("TooManyErrors", {
 *   serviceId: analytics.serviceId,
 *   name: "Too many errors",
 *   source: "saved_search",
 *   savedSearchId: errors.id,
 *   interval: "5m",
 *   threshold: 100,
 *   thresholdType: "above",
 *   channels: [{ type: "webhook", webhookId: oncall.id }],
 * });
 * ```
 *
 * :::caution
 * Changing `serviceId` replaces the object.
 * :::
 *
 * @resource
 * @product ClickStack
 */
export const Alert = Resource<Alert>("ClickHouseCloud.ClickStack.Alert");

const getAlert = (organizationId: string, serviceId: string, id: string) =>
  stack.getClickStackAlert({ organizationId, serviceId, clickStackAlertId: id }).pipe(
    Effect.flatMap(requireResult("getAlert")),
    Effect.map((found): stack.ClickStackAlertResponse | undefined => found),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

export const AlertProvider = () =>
  Provider.effect(
    Alert,
    Effect.succeed({
      stables: ["id", "serviceId", "organizationId"],
      nuke: { dependsOn: [] },
      list: () => Effect.succeed([]),
      diff: Effect.fn(function* ({ news, olds }) {
        if (!isResolved(news) || olds === undefined) return undefined;
        if (news.serviceId !== olds.serviceId) {
          return { action: "replace" } as const;
        }
        return undefined;
      }),
      read: Effect.fn(function* ({ output }) {
        if (output === undefined) return undefined;
        const found = yield* getAlert(output.organizationId, output.serviceId, output.id);
        return found === undefined ? undefined : { ...output, observed: found };
      }),
      reconcile: Effect.fn(function* ({ news, output, bindings }) {
        const organizationId = output?.organizationId ?? (yield* currentOrganizationId);
        const { serviceId } = news;
        // Desired channels: the declared ones plus every bound host's webhook.
        const bound = bindings.flatMap((b) => b.data.webhookIds);
        const declared = (({ serviceId: _, ...rest }) => rest)(news);
        const body = {
          ...declared,
          ...(bound.length > 0
            ? {
                channels: [
                  ...(declared.channels ?? []),
                  ...bound.map((webhookId) => ({ type: "webhook", webhookId })),
                ],
              }
            : {}),
        };
        // Observe
        const observed = output?.id
          ? yield* getAlert(organizationId, serviceId, output.id)
          : undefined;
        if (observed !== undefined && output !== undefined && covers(observed, body)) {
          return { id: output.id, serviceId, organizationId, observed };
        }
        // Ensure or sync: a PUT carries the whole object.
        const saved =
          observed === undefined
            ? yield* stack
                .createClickStackAlert({ organizationId, serviceId, ...body })
                .pipe(Effect.flatMap(requireResult("createAlert")))
            : yield* ((id: string) =>
                stack.updateClickStackAlert({
                  organizationId,
                  serviceId,
                  clickStackAlertId: id,
                  ...body,
                }))(observed.id!).pipe(Effect.flatMap(requireResult("updateAlert")));
        if (saved.id === undefined)
          return yield* new ResultMissing({ operation: "createAlert (id)" });
        return { id: saved.id, serviceId, organizationId, observed: saved };
      }),
      delete: Effect.fn(function* ({ output }) {
        const { organizationId, serviceId, id } = output;
        yield* stack
          .deleteClickStackAlert({ organizationId, serviceId, clickStackAlertId: id })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
      }),
    }),
  );
