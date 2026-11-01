import * as automation from "@distilled.cloud/stackit/automation";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { StackitEnvironment } from "../Environment.ts";
import { projectScopeChanged, resolveProjectScope } from "../IaaS/internal.ts";
import { hasUnresolvedTrigger, rawProp, triggerProps } from "../internal/diff.ts";
import { ensureServiceEnabled } from "../internal/enable.ts";
import { isGeneratedPhysicalName } from "../internal/names.ts";
import type { Providers } from "../Providers.ts";
import {
  AUTOMATION_NAME_MAX_LENGTH,
  AUTOMATION_SERVICE_ID,
  type AutomationScope,
  generatedAutomationName,
  getAutomationOrUndefined,
  listProjectAutomations,
  RECOVERY_POINT_KIND,
} from "./internal.ts";

/** How long the recovery points an automation creates are kept. */
export type SnapshotRetentionPolicy =
  | {
      /** Keep the newest `value` recovery points. */
      kind: "count";
      /** How many recovery points to keep. */
      value: number;
    }
  | {
      /** Keep every recovery point. */
      kind: "indefinitely";
    };

/** What a `VolumeRecoveryPointManagement` template works on. */
export interface VolumeRecoveryPointInput {
  /**
   * Kind of template input.
   *
   * @default "VolumeRecoveryPointManagement"
   */
  kind?: "VolumeRecoveryPointManagement";
  /**
   * Which volumes to cover, by their labels, e.g. `backup=daily,env=prod`.
   */
  volumeLabelSelector?: string;
  /** Labels to put on the recovery points. */
  recoveryPointLabels?: Record<string, string>;
  /**
   * Whether recovery points inherit the labels of their volume.
   *
   * @default false
   */
  inheritVolumeLabels?: boolean;
  /** How long recovery points are kept. */
  snapshotRetentionPolicy: SnapshotRetentionPolicy;
}

export interface VolumeAutomationProps {
  /**
   * Template the automation runs: list the region's templates with
   * `Stackit.Automation.ListVolumeTemplates`. Changing it replaces the automation.
   */
  templateId: string;
  /**
   * Name of the automation. Updates in place.
   *
   * If omitted, a name is generated from the stack, stage and logical ID.
   */
  name?: string;
  /** Description of the automation. Updates in place; omit to leave the live value alone. */
  description?: string;
  /**
   * What the template works on. Updates in place, replacing the whole input; omit to leave
   * the live value alone.
   */
  input?: VolumeRecoveryPointInput;
  /**
   * When to run: an iCalendar (RFC 5545) recurrence rule. Updates in place. Without it, or
   * once removed, the automation has no schedule and only runs through
   * `Stackit.Automation.CreateVolumeExecution`.
   */
  schedule?: string;
  /** Project of the automation. Defaults to the profile's project. Changing it replaces the automation. */
  projectId?: string;
  /** Region of the automation. Defaults to the profile's region. Changing it replaces the automation. */
  region?: string;
}

export interface VolumeAutomationAttributes {
  /** STACKIT automation id (UUID). Stable across updates. */
  automationId: string;
  /** Project of the automation. */
  projectId: string;
  /** Region of the automation. */
  region: string;
  /** Template the automation runs. */
  templateId: string | undefined;
  /** Name of the automation. */
  name: string | undefined;
  /** Description of the automation, if any. */
  description: string | undefined;
  /** What the template works on, as STACKIT returns it. */
  input: automation.VolumeAutomationInput | undefined;
  /** The recurrence rule, if the automation has a schedule. */
  schedule: string | undefined;
  /** The steps of the template, as STACKIT reports them on the automation. */
  steps: automation.VolumeOutputStep[];
  /** When the automation was created. */
  createTime: string;
  /** When the automation last changed. */
  updateTime: string;
}

export type VolumeAutomation = Resource<
  "Stackit.Automation.VolumeAutomation",
  VolumeAutomationProps,
  VolumeAutomationAttributes,
  never,
  Providers
>;

/**
 * A STACKIT volume automation: scheduled recovery points of the volumes matching a label
 * selector, from one of STACKIT's fixed templates. You pick a template and configure it; you
 * can't write its steps.
 *
 * The automation itself is free. Its recovery points bill as snapshot storage, so a broad
 * selector with `indefinitely` keeps costing more. The first deploy enables the service
 * (`cloud.stackit.automation`) for the project.
 *
 * Everything but the template, project and region updates in place. Automations have no
 * labels: Alchemy recognizes its own by the id in state or the generated name, which holds the
 * resource's instance id. An automation with the same explicit `name` found without state is
 * reported as unowned, and only taken over with `--adopt`. `alchemy unsafe nuke` enumerates
 * only automations whose name has the generated shape.
 *
 * See [STACKIT's Automation docs](https://docs.stackit.cloud/products/integration/automation-service/).
 *
 * :::caution[Changing `templateId`, `projectId` or `region` replaces the Automation]
 * A deploy creates a new automation and deletes the old one. With an explicit `name`
 * that stays the same in the same project and region, the old automation goes first.
 * An automation changed in the portal keeps its live values until a deploy changes its
 * props.
 * :::
 *
 * ### Creating an Automation
 * **Example:** Daily recovery points, keeping the last seven
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const nightly = yield* Stackit.Automation.VolumeAutomation("Nightly", {
 *   templateId: "62c5178a-87fb-437f-88c8-c6f26b3ee4f6",
 *   description: "Nightly recovery points",
 *   schedule: "DTSTART;TZID=Europe/Berlin:20300101T023000 RRULE:FREQ=DAILY;INTERVAL=1",
 *   input: {
 *     volumeLabelSelector: "backup=nightly",
 *     recoveryPointLabels: { "created-by": "alchemy" },
 *     snapshotRetentionPolicy: { kind: "count", value: 7 },
 *   },
 * });
 * ```
 *
 * ### Covering a Volume
 * **Example:** Label a volume so the automation picks it up
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const data = yield* Stackit.IaaS.Volume("Data", {
 *   size: 20,
 *   labels: { backup: "nightly" },
 * });
 * const nightly = yield* Stackit.Automation.VolumeAutomation("Nightly", {
 *   templateId: "62c5178a-87fb-437f-88c8-c6f26b3ee4f6",
 *   schedule: "DTSTART;TZID=Europe/Berlin:20300101T023000 RRULE:FREQ=DAILY;INTERVAL=1",
 *   input: {
 *     volumeLabelSelector: "backup=nightly",
 *     inheritVolumeLabels: true,
 *     snapshotRetentionPolicy: { kind: "indefinitely" },
 *   },
 * });
 * ```
 *
 * ### Running on Demand
 * **Example:** Take a recovery point from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const OnDemand = Stackit.Automation.VolumeAutomation("OnDemand", {
 *   templateId: "62c5178a-87fb-437f-88c8-c6f26b3ee4f6",
 *   input: {
 *     volumeLabelSelector: "backup=on-demand",
 *     snapshotRetentionPolicy: { kind: "count", value: 3 },
 *   },
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const run = yield* Stackit.Automation.CreateVolumeExecution(yield* OnDemand);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const execution = yield* run();
 *         return yield* HttpServerResponse.json({ id: execution.id });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Automation.CreateVolumeExecutionHttp)),
 * ) {}
 * ```
 *
 * ### What Deleting Does <!-- api-prose -->
 * A delete makes one call, to delete this one automation by its id. It makes no call against
 * the recovery points the automation created, so delete those you don't want through
 * `Stackit.IaaS` or the portal. An automation that's already gone counts as deleted.
 *
 * @resource
 * @product STACKIT Automation
 * @category Automation
 */
export const VolumeAutomation = Resource<VolumeAutomation>("Stackit.Automation.VolumeAutomation");

/** What a get and a list item share; a list item has no input or steps. */
type ObservedAutomation = automation.ListAutomationsItem &
  Partial<Pick<automation.VolumeAutomation, "input" | "output">>;

const toAttrs = (
  scope: AutomationScope,
  observed: ObservedAutomation,
): VolumeAutomationAttributes => ({
  automationId: observed.id,
  projectId: scope.projectId,
  region: scope.region,
  templateId: observed.templateId,
  name: observed.name ?? undefined,
  description: observed.description === "" ? undefined : (observed.description ?? undefined),
  input: observed.input ?? undefined,
  schedule: observed.triggers?.schedule?.rrule,
  steps: [...(observed.output?.steps ?? [])],
  createTime: observed.createTime,
  updateTime: observed.updateTime,
});

/** Same content in a stable form: object keys sorted, undefined members dropped. */
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => [key, canonical(item)]),
  );
};

/**
 * An input in comparable form. An unset member and its default mean the same, whichever one
 * STACKIT sends back.
 */
const inputKey = (input: Readonly<Record<string, unknown>> | null | undefined): string =>
  JSON.stringify(
    canonical({
      ...input,
      inheritVolumeLabels: input?.inheritVolumeLabels ?? false,
      recoveryPointLabels: input?.recoveryPointLabels ?? {},
      volumeLabelSelector: input?.volumeLabelSelector ?? "",
    }),
  );

const desiredInputOf = (
  news: VolumeAutomationProps,
): automation.VolumeAutomationInput | undefined =>
  news.input === undefined
    ? undefined
    : { ...news.input, kind: news.input.kind ?? RECOVERY_POINT_KIND };

const triggersOf = (schedule: string): automation.AutomationTriggers => ({
  schedule: { rrule: schedule },
});

/**
 * What differs from the observed automation: the field mask and the body it reads. A masked
 * field missing from the body is removed, as the spec's "remove trigger" example does with
 * `triggers`, and a masked `input` replaces the whole input.
 */
const deltaOf = (
  observed: automation.VolumeAutomation,
  news: VolumeAutomationProps,
  name: string,
) => {
  const mask: string[] = [];
  const body: Pick<
    automation.PartialUpdateVolumeAutomationRequest,
    "name" | "description" | "input" | "triggers"
  > = {};
  if (observed.name !== name) {
    mask.push("name");
    body.name = name;
  }
  if (news.description !== undefined && (observed.description ?? "") !== news.description) {
    mask.push("description");
    body.description = news.description;
  }
  const input = desiredInputOf(news);
  if (input !== undefined && inputKey(observed.input) !== inputKey(input)) {
    mask.push("input");
    body.input = input;
  }
  if (observed.triggers?.schedule?.rrule !== news.schedule) {
    mask.push("triggers");
    if (news.schedule !== undefined) body.triggers = triggersOf(news.schedule);
  }
  return { mask, body };
};

export const VolumeAutomationProvider = () =>
  Provider.succeed(VolumeAutomation, {
    stables: ["automationId", "projectId", "region"],

    // No labels: only generated names are enumerated.
    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      const scope = { projectId: env.projectId, region: env.region };
      const items = yield* listProjectAutomations(scope);
      return items
        .filter(
          (item) =>
            item.name !== undefined &&
            item.name !== null &&
            isGeneratedPhysicalName(item.name, AUTOMATION_NAME_MAX_LENGTH),
        )
        .map((item) => toAttrs(scope, item));
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (output === undefined) return undefined;
      const explicitName = rawProp<VolumeAutomationProps>(news, "name");
      // A generated name carries the generation, so it can't collide.
      if (
        hasUnresolvedTrigger<VolumeAutomationProps>(news, ["templateId", "projectId", "region"])
      ) {
        return { action: "replace", deleteFirst: explicitName !== undefined } as const;
      }
      const resolved = triggerProps<VolumeAutomationProps>(news);
      if (yield* projectScopeChanged(resolved, output)) {
        return { action: "replace", deleteFirst: false } as const;
      }
      const templateId = olds?.templateId ?? output.templateId;
      if (templateId !== undefined && resolved.templateId !== templateId) {
        return {
          action: "replace",
          // The spec doesn't say whether a name is unique, so a name that stays goes first.
          deleteFirst:
            explicitName !== undefined &&
            (!isResolved(explicitName) || explicitName === output.name),
        } as const;
      }
      // Everything else updates in place (engine default: props changed).
      return undefined;
    }),

    read: Effect.fn(function* ({ id, instanceId, olds, output, previous }) {
      const scope = yield* resolveProjectScope(olds, output);
      if (output !== undefined) {
        const byId = yield* getAutomationOrUndefined(scope, output.automationId);
        if (byId !== undefined) return toAttrs(scope, byId);
      }
      const items = yield* listProjectAutomations(scope);
      if (olds?.name === undefined) {
        // A generated name holds this generation's instance id, so finding it proves it's ours.
        const generated = yield* generatedAutomationName(id, instanceId);
        const found = items.find((item) => item.name === generated);
        if (found === undefined) return undefined;
        const live = yield* getAutomationOrUndefined(scope, found.id);
        return live === undefined ? undefined : toAttrs(scope, live);
      }
      // A name found twice is evidently no identity, so it claims nothing.
      const named = items.filter((item) => item.name === olds.name);
      if (named.length !== 1) return undefined;
      const live = yield* getAutomationOrUndefined(scope, named[0]!.id);
      if (live === undefined) return undefined;
      const attrs = toAttrs(scope, live);
      // A name is no identity across projects and regions: the generation being replaced only
      // counts at this same scope.
      const isPrevious =
        previous?.automationId === attrs.automationId &&
        previous.projectId === scope.projectId &&
        previous.region === scope.region;
      return isPrevious ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, output }) {
      const scope = yield* resolveProjectScope(news, output);
      yield* ensureServiceEnabled({ ...scope, serviceId: AUTOMATION_SERVICE_ID });

      const generated = yield* generatedAutomationName(id, instanceId);
      const name = news.name ?? output?.name ?? generated;

      // 1. Observe — `output` is a cache for the id, and only names the desired automation at
      // the same scope. Without it, only this generation's generated name can be claimed.
      let current: automation.VolumeAutomation | undefined =
        output !== undefined &&
        output.projectId === scope.projectId &&
        output.region === scope.region
          ? yield* getAutomationOrUndefined(scope, output.automationId)
          : undefined;
      if (current === undefined && name === generated) {
        const items = yield* listProjectAutomations(scope);
        const found = items.find((item) => item.name === generated);
        if (found !== undefined) current = yield* getAutomationOrUndefined(scope, found.id);
      }

      // 2. Ensure
      if (current === undefined) {
        const input = desiredInputOf(news);
        current = yield* automation.createVolumeAutomation({
          ...scope,
          templateId: news.templateId,
          name,
          ...(news.description !== undefined ? { description: news.description } : {}),
          ...(input !== undefined ? { input } : {}),
          ...(news.schedule !== undefined ? { triggers: triggersOf(news.schedule) } : {}),
        });
      }

      // 3. Sync — one PATCH naming only what differs from the observed automation.
      const { mask, body } = deltaOf(current, news, name);
      if (mask.length > 0) {
        current = yield* automation.partialUpdateVolumeAutomation({
          ...scope,
          automationId: current.id,
          updateMask: mask.join(","),
          ...body,
        });
      }

      // 4. Return
      return toAttrs(scope, current);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* automation
        .deleteVolumeAutomation({
          projectId: output.projectId,
          region: output.region,
          automationId: output.automationId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
