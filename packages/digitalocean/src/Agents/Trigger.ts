import * as DO from "@distilled.cloud/digitalocean";
import type { Trigger as ApiTrigger } from "@distilled.cloud/digitalocean";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { ignoreNotFound, noneIfNotFound } from "../internal/notFound.ts";
import type { Providers } from "../Providers.ts";

export type TriggerOutput =
  | { mode: "none" }
  | { mode: "email"; email: string }
  | { mode: "slack"; webhookUrl: string | Redacted.Redacted<string> };

export type TriggerProps = {
  /**
   * Trigger name. Updates in place.
   *
   * @default a generated physical name
   */
  name?: string;
  /** Run on a cron schedule. A change of the kind of trigger replaces it. */
  cron?: { expression: string; timeZone?: string };
  /** Run on each delivery to the trigger's webhook. */
  webhook?: { provider?: string };
  /** The prompt each run starts with; webhook payload fields can be interpolated. */
  prompt: string;
  /**
   * The environment each run starts a fresh session from: an agent manifest
   * (YAML text, or an object sent as JSON). A headless run cannot ask, so
   * the manifest needs `spec.permissions`. Updates in place.
   */
  session: string | Record<string, unknown>;
  /** Where each run's output goes. @default { mode: "none" } */
  output?: TriggerOutput;
  /** Whether the trigger fires. @default true */
  enabled?: boolean;
};

export type Trigger = Resource<
  "DigitalOcean.Agents.Trigger",
  TriggerProps,
  {
    /** Trigger id. */
    triggerId: string;
    /** Trigger name. */
    name: string;
    /** `cron` or `webhook`. */
    kind: string;
    /** The URL a webhook trigger receives deliveries on. */
    webhookUrl: string | undefined;
    /** The secret a webhook delivery is signed with. Returned only at create. */
    webhookSecret: Redacted.Redacted<string> | undefined;
  },
  never,
  Providers
>;

export type TriggerAttributes = Trigger["Attributes"];

/**
 * A Harness Runtime trigger: starts an agent run in a fresh session on a
 * cron schedule or on each webhook delivery, and sends its output by email,
 * to Slack, or nowhere. The schedule, prompt, session spec and output update
 * in place; switching between cron and webhook replaces the trigger.
 *
 * ### Scheduling an Agent Run
 * **Example:** A weekday summary at 09:00
 * ```typescript
 * yield* DigitalOcean.Agents.Trigger("standup", {
 *   cron: { expression: "0 9 * * 1-5", timeZone: "America/New_York" },
 *   prompt: "Summarize yesterday's merged pull requests.",
 *   session: {
 *     apiVersion: "agents.digitalocean.com/v1alpha1",
 *     kind: "Agent",
 *     spec: { runtime: { adapter: "opencode" }, permissions: { defaultAction: "allow" } },
 *   },
 *   output: { mode: "email", email: "team@example.com" },
 * });
 * ```
 *
 * @see https://docs.digitalocean.com/reference/api/digitalocean/#tag/Harness-Runtime
 *
 * @resource
 * @product Harness Runtime
 * @category AI
 */
export const Trigger = Resource<Trigger>("DigitalOcean.Agents.Trigger");

const physicalName = (id: string) => createPhysicalName({ id, lowercase: true, maxLength: 63 });

const text = (value: string | Record<string, unknown>) =>
  typeof value === "string" ? value : JSON.stringify(value);

const outputOf = (output: TriggerOutput | undefined) =>
  output === undefined || output.mode === "none"
    ? { mode: "none" }
    : output.mode === "email"
      ? { mode: "email", email: output.email }
      : {
          mode: "slack",
          slack: {
            webhook_url:
              typeof output.webhookUrl === "string"
                ? output.webhookUrl
                : Redacted.value(output.webhookUrl),
          },
        };

const kindOf = (props: TriggerProps) => (props.cron !== undefined ? "cron" : "webhook");

const toAttrs = (
  trigger: ApiTrigger,
  webhookSecret: Redacted.Redacted<string> | undefined,
): TriggerAttributes => ({
  triggerId: trigger.trigger_id,
  name: trigger.name,
  kind: trigger.kind,
  webhookUrl: trigger.webhook?.webhook_url,
  webhookSecret,
});

const observe = (triggerId: string) =>
  noneIfNotFound(
    DO.harnessGetTrigger({ trigger_id: triggerId }).pipe(Effect.map((r) => r.trigger)),
  );

export const TriggerProvider = () =>
  Provider.succeed(Trigger, {
    stables: ["triggerId", "kind", "webhookUrl", "webhookSecret"],
    nuke: { skip: true },
    read: Effect.fn(function* ({ output }) {
      if (output === undefined) return undefined;
      const observed = yield* observe(output.triggerId);
      return Option.getOrUndefined(
        Option.map(observed, (trigger) => toAttrs(trigger, output.webhookSecret)),
      );
    }),
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      if (kindOf(news) !== kindOf(olds)) return { action: "replace" } as const;
    }),
    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const name = news.name ?? output?.name ?? (yield* physicalName(id));
      const status = news.enabled === false ? "paused" : "active";
      const cron =
        news.cron === undefined
          ? undefined
          : { cron_expr: news.cron.expression, timezone: news.cron.timeZone ?? "UTC" };
      const observed =
        output === undefined ? Option.none<ApiTrigger>() : yield* observe(output.triggerId);
      if (Option.isNone(observed)) {
        const created = yield* DO.harnessCreateTrigger({
          kind: kindOf(news),
          name,
          session_mode: "fresh",
          prompt_template: news.prompt,
          session_template: text(news.session),
          output: outputOf(news.output) as DO.TriggerOutputWrite,
          cron,
          webhook: news.webhook === undefined ? undefined : { provider: news.webhook.provider },
        });
        if (status === "paused") {
          yield* DO.harnessUpdateTrigger({ trigger_id: created.trigger.trigger_id, status });
        }
        const secret = created.webhook_secret;
        return toAttrs(
          created.trigger,
          secret === undefined
            ? undefined
            : typeof secret === "string"
              ? Redacted.make(secret)
              : secret,
        );
      }
      const current = observed.value;
      // The session spec and the output's destination are write-only, so a
      // change in them is seen by comparing the props.
      const same =
        current.name === name &&
        current.status === status &&
        current.prompt_template === news.prompt &&
        current.cron?.cron_expr === cron?.cron_expr &&
        (cron === undefined || current.cron?.timezone === cron.timezone) &&
        olds !== undefined &&
        text(olds.session) === text(news.session) &&
        JSON.stringify(outputOf(olds.output)) === JSON.stringify(outputOf(news.output));
      if (!same) {
        yield* DO.harnessUpdateTrigger({
          trigger_id: current.trigger_id,
          name,
          status,
          prompt_template: news.prompt,
          session_template: text(news.session),
          output: outputOf(news.output) as DO.TriggerOutputWrite,
          cron,
        });
      }
      const final = yield* observe(current.trigger_id);
      return toAttrs(
        Option.getOrElse(final, () => current),
        output?.webhookSecret,
      );
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(DO.harnessDeleteTrigger({ trigger_id: output.triggerId }));
    }),
  });
