import * as DO from "@distilled.cloud/digitalocean";
import type { TriggerInfo } from "@distilled.cloud/digitalocean";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ignoreNotFound, noneIfNotFound } from "../internal/notFound.ts";
import type { Providers } from "../Providers.ts";

export type TriggerProps = {
  /** The namespace id (`fn-<uuid>`). A change replaces the trigger. */
  namespaceId: string;
  /** The function the trigger runs. A change replaces the trigger. */
  function: string;
  /** Cron schedule, five fields, in UTC. Updates in place. */
  cron: string;
  /** Parameters each scheduled run receives. Updates in place. */
  body?: Record<string, unknown>;
  /** Whether the schedule runs. @default true */
  enabled?: boolean;
  /**
   * Trigger name in the namespace.
   *
   * @default a generated physical name
   */
  name?: string;
};

export type Trigger = Resource<
  "DigitalOcean.Functions.Trigger",
  TriggerProps,
  {
    /** Trigger name. */
    name: string;
    /** The namespace id. */
    namespaceId: string;
    /** The function the trigger runs. */
    function: string;
  },
  never,
  Providers
>;

/**
 * Runs a function on a cron schedule. The schedule, body and `enabled`
 * update in place.
 *
 * ### Scheduling a Function
 * **Example:** Every 5 minutes
 * ```typescript
 * yield* DigitalOcean.Functions.Trigger("every-5m", {
 *   namespaceId: fns.namespaceId,
 *   function: cleanup.name,
 *   cron: "*\/5 * * * *",
 *   body: { dryRun: false },
 * });
 * ```
 *
 * @see https://docs.digitalocean.com/products/functions/how-to/schedule-functions/
 *
 * @resource
 * @product Functions
 * @category Compute
 */
export const Trigger = Resource<Trigger>("DigitalOcean.Functions.Trigger");

const physicalName = (id: string) => createPhysicalName({ id, lowercase: true, maxLength: 63 });

const observe = (namespaceId: string, name: string) =>
  noneIfNotFound(
    DO.functionsGetTrigger({ namespace_id: namespaceId, trigger_name: name }).pipe(
      Effect.map((r) => r.trigger),
    ),
  );

const toAttrs = (trigger: TriggerInfo) => ({
  name: trigger.name,
  namespaceId: trigger.namespace,
  function: trigger.function,
});

export const TriggerProvider = () =>
  Provider.succeed(Trigger, {
    stables: ["namespaceId", "function"],
    nuke: { skip: true },
    read: Effect.fn(function* ({ id, olds, output }) {
      const name = output?.name ?? olds.name ?? (yield* physicalName(id));
      const observed = yield* observe(olds.namespaceId, name);
      return Option.getOrUndefined(Option.map(observed, toAttrs));
    }),
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      if (
        news.namespaceId !== olds.namespaceId ||
        news.function !== olds.function ||
        news.name !== olds.name
      ) {
        return { action: "replace" } as const;
      }
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const name = news.name ?? output?.name ?? (yield* physicalName(id));
      const scheduled_details = { cron: news.cron, body: news.body ?? null };
      const enabled = news.enabled ?? true;
      const observed = yield* observe(news.namespaceId, name);
      if (Option.isNone(observed)) {
        const { trigger } = yield* DO.functionsCreateTrigger({
          namespace_id: news.namespaceId,
          name,
          function: news.function,
          type: "SCHEDULED",
          is_enabled: enabled,
          scheduled_details,
        });
        return toAttrs(trigger);
      }
      const current = observed.value;
      const same =
        current.is_enabled === enabled &&
        current.scheduled_details?.cron === news.cron &&
        JSON.stringify(current.scheduled_details?.body ?? null) ===
          JSON.stringify(scheduled_details.body);
      if (same) return toAttrs(current);
      const { trigger } = yield* DO.functionsUpdateTrigger({
        namespace_id: news.namespaceId,
        trigger_name: name,
        is_enabled: enabled,
        scheduled_details,
      });
      return toAttrs(trigger);
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(
        DO.functionsDeleteTrigger({ namespace_id: output.namespaceId, trigger_name: output.name }),
      );
    }),
  });
