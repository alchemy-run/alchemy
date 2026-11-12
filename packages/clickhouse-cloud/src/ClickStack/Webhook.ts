import { createHash } from "node:crypto";
import * as stack from "@distilled.cloud/clickhouse-cloud/click_stack";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { organizationId as currentOrganizationId } from "../Credentials.ts";
import { OperationFailed, ResultMissing, requireResult } from "../Errors.ts";
import type { Providers } from "../Providers.ts";
import { type ClickStackScope, covers } from "./internal.ts";

export type WebhookProps = ClickStackScope &
  Omit<
    stack.CreateClickStackWebhookRequest,
    "organizationId" | "serviceId" | "headers" | "queryParams" | "url"
  > & {
    /** Destination URL. For incoming webhooks the URL is the credential, so it is `Redacted`. */
    url: Redacted.Redacted<string>;
    /** Headers sent with every call, e.g. a shared secret. Write-only. */
    headers?: Record<string, Redacted.Redacted<string>>;
    /** Query parameters added to every call. Write-only. */
    queryParams?: Record<string, Redacted.Redacted<string>>;
  };

export interface WebhookAttributes {
  /** ID of the webhook. */
  id: string;
  /** Service ID. */
  serviceId: string;
  /** Organization ID. */
  organizationId: string;
  /** The object as ClickStack stores it. */
  observed: stack.ClickStackWebhook;
  /** SHA-256 of the write-only fields last applied. */
  secretDigest: Redacted.Redacted<string>;
}

export type Webhook = Resource<
  "ClickHouseCloud.ClickStack.Webhook",
  WebhookProps,
  WebhookAttributes,
  never,
  Providers
>;

/**
 * A ClickStack alert destination: a Slack incoming webhook, incident.io,
 * or any HTTP endpoint (`generic`) with an optional Handlebars `body`.
 *
 * ClickStack is in public beta and must be set up for the service in the
 * console before its API answers. Updates send the whole object (PUT), so
 * the props are the full definition. `url`, `headers` and `queryParams` are never returned, so a change
 * is detected from the digest of the last values applied. Deploy validates
 * the URL and template before saving. A webhook an alert still uses can't
 * be deleted: alerts are deleted first.
 * Objects in ClickStack carry no alchemy marker, so only those in state
 * are managed. Needs `control-plane:service:manage-clickstack-api`.
 * @see https://clickhouse.com/docs/use-cases/observability/clickstack
 *
 * ### Creating a Webhook
 * **Example:** In the service's ClickStack
 * ```typescript
 * yield* ClickHouseCloud.ClickStack.Webhook("Oncall", {
 *   serviceId: analytics.serviceId,
 *   name: "oncall",
 *   service: "slack",
 *   url: yield* Config.redacted("SLACK_WEBHOOK_URL"),
 * });
 * ```
 *
 * :::caution
 * Changing `serviceId` replaces the object.
 * :::
 *
 * Uses ClickHouse Cloud API endpoints marked Beta: `createClickStackWebhook`, `deleteClickStackWebhook`, `listClickStackWebhooks`, `updateClickStackWebhook`, `validateClickStackWebhook`.
 *
 * @resource
 * @product ClickStack
 */
export const Webhook = Resource<Webhook>("ClickHouseCloud.ClickStack.Webhook");

const unredact = (map: Record<string, Redacted.Redacted<string>> | undefined) =>
  map === undefined
    ? undefined
    : Object.fromEntries(Object.entries(map).map(([k, v]) => [k, Redacted.value(v)]));

const secretDigestOf = (props: WebhookProps) =>
  Redacted.make(
    createHash("sha256")
      .update(
        JSON.stringify([
          Redacted.value(props.url),
          unredact(props.headers) ?? null,
          unredact(props.queryParams) ?? null,
        ]),
      )
      .digest("hex"),
  );

const getWebhook = (organizationId: string, serviceId: string, id: string) =>
  stack.listClickStackWebhooks({ organizationId, serviceId, limit: 1000 }).pipe(
    Effect.flatMap(requireResult("listClickStackWebhooks")),
    // No get-by-id operation: the webhook is found in the list.
    Effect.map((all) => all.find((w) => w.id === id)),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

export const WebhookProvider = () =>
  Provider.effect(
    Webhook,
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
        const found = yield* getWebhook(output.organizationId, output.serviceId, output.id);
        return found === undefined ? undefined : { ...output, observed: found };
      }),
      reconcile: Effect.fn(function* ({ news, output }) {
        const organizationId = output?.organizationId ?? (yield* currentOrganizationId);
        const { serviceId } = news;
        const body = {
          ...(({ serviceId: _, headers: _headers, queryParams: _queryParams, ...rest }) => rest)(
            news,
          ),
          headers: unredact(news.headers),
          queryParams: unredact(news.queryParams),
        };
        const secretDigest = secretDigestOf(news);
        // Observe
        const observed = output?.id
          ? yield* getWebhook(organizationId, serviceId, output.id)
          : undefined;
        if (
          observed !== undefined &&
          output !== undefined &&
          Redacted.value(output.secretDigest) === Redacted.value(secretDigest) &&
          covers(observed, body, ["headers", "queryParams", "url"])
        ) {
          return { id: output.id, serviceId, organizationId, observed, secretDigest };
        }
        // Validate first: ClickStack answers with field errors instead of a rejected write.
        const validation = yield* stack
          .validateClickStackWebhook({ organizationId, serviceId, ...body })
          .pipe(Effect.flatMap(requireResult("validateWebhook")));
        if (!validation.valid) {
          return yield* new OperationFailed({
            kind: "ClickStack webhook",
            id: String(body.name),
            state: "invalid",
            detail: JSON.stringify(validation.errors),
          });
        }
        // Ensure or sync: a PUT carries the whole object.
        const saved =
          observed === undefined
            ? yield* stack
                .createClickStackWebhook({ organizationId, serviceId, ...body })
                .pipe(Effect.flatMap(requireResult("createWebhook")))
            : yield* ((id: string) =>
                stack.updateClickStackWebhook({
                  organizationId,
                  serviceId,
                  clickStackWebhookId: id,
                  ...body,
                }))(observed.id!).pipe(Effect.flatMap(requireResult("updateWebhook")));
        if (saved.id === undefined)
          return yield* new ResultMissing({ operation: "createWebhook (id)" });
        return { id: saved.id, serviceId, organizationId, observed: saved, secretDigest };
      }),
      delete: Effect.fn(function* ({ output }) {
        const { organizationId, serviceId, id } = output;
        yield* stack
          .deleteClickStackWebhook({ organizationId, serviceId, clickStackWebhookId: id })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
      }),
    }),
  );
