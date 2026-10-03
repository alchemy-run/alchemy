import * as workers from "@distilled.cloud/cloudflare/workers";
import * as Effect from "effect/Effect";
import * as Effectable from "effect/Effectable";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import type { Input, PropsInput } from "../../Input.ts";
import * as Provider from "../../Provider.ts";
import {
  isResourceOfType,
  Resource,
  type ResourceClass,
} from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import type {
  WorkflowBinding,
  WorkflowResource,
} from "../Workflows/Workflow.ts";

const TypeId = "Cloudflare.Workers.EventTriggers" as const;
type TypeId = typeof TypeId;

/** Artifacts events a Worker can deliver straight to a Workflow. */
export type ArtifactsEventType =
  | "cf.artifacts.repo.created"
  | "cf.artifacts.repo.deleted"
  | "cf.artifacts.repo.forked"
  | "cf.artifacts.repo.imported"
  | "cf.artifacts.repo.pushed"
  | "cf.artifacts.repo.cloned"
  | "cf.artifacts.repo.fetched"
  | "cf.artifacts.repo.token.created"
  | "cf.artifacts.repo.token.revoked";

export type EventTrigger = {
  /**
   * The event that starts the Workflows, e.g. `cf.artifacts.repo.pushed`.
   */
  type: ArtifactsEventType;
  /**
   * Narrows the event to one Artifacts namespace, or one repository in it.
   * Without a filter, the event fires for every repository in the account.
   */
  filter?: {
    /** Only events from repositories in this namespace. */
    namespace?: string;
    /** Only events from the repository with this name. */
    repoName?: string;
  };
  /**
   * Physical names of the Workflows that each get a new instance per event,
   * with the event as its params. Each must be hosted by `scriptName`.
   */
  workflows: string[];
};

export type EventTriggersProps = {
  /**
   * Name of the Worker script that hosts the target Workflows (e.g.
   * `worker.workerName`). Changing it replaces the resource: the old script's
   * triggers are cleared.
   */
  scriptName: string;
  /**
   * Every event trigger of the script. They replace the script's list
   * wholesale, so declare one `EventTriggers` per script. An empty list
   * clears it.
   */
  triggers: EventTrigger[];
};

export type EventTriggersAttributes = {
  /** The Cloudflare account the script belongs to. */
  accountId: string;
  /** The Worker script the triggers belong to. */
  scriptName: string;
  /** The script's event triggers, as Cloudflare stores them. */
  triggers: EventTrigger[];
};

export type EventTriggers = Resource<
  TypeId,
  EventTriggersProps,
  EventTriggersAttributes,
  never,
  Providers
>;

/** A trigger as the constructor takes it: Workflows by name, binding, or resource. */
export type EventTriggerInput = Omit<PropsInput<EventTrigger>, "workflows"> & {
  workflows: (Input<string> | WorkflowBinding | WorkflowResource)[];
};

/** Constructor inputs; Workflow bindings and resources become their physical names. */
export type EventTriggersInput = Omit<
  PropsInput<EventTriggersProps>,
  "triggers"
> & {
  triggers: EventTriggerInput[];
};

type EventTriggersConstructor<Req = never> = {
  Type: TypeId;
  Props: EventTriggersProps;
  <const Methods extends Record<string, any>>(
    methods: Methods,
  ): EventTriggersClass & Methods;
  (
    id: string,
    props: EventTriggersInput,
  ): Effect.Effect<EventTriggers, never, Req>;
  <PropsReq = never>(
    id: string,
    props: Effect.Effect<EventTriggersInput, never, PropsReq>,
  ): Effect.Effect<EventTriggers, never, PropsReq | Req>;
};

type EventTriggersClass = EventTriggersConstructor<Providers> &
  Effect.Effect<EventTriggersConstructor> &
  Pick<ResourceClass<EventTriggers>, "Self" | "Provider" | "Aliases" | "ref">;

const EventTriggersResource = Resource<EventTriggers>(TypeId);

const isWorkflowBinding = (
  workflow: EventTriggerInput["workflows"][number],
): workflow is WorkflowBinding =>
  typeof workflow === "object" &&
  workflow !== null &&
  (workflow as WorkflowBinding).kind === "Cloudflare.Workflow";

const isWorkflowResource = (
  workflow: EventTriggerInput["workflows"][number],
): workflow is WorkflowResource =>
  isResourceOfType(workflow, "Cloudflare.Workflow");

const workflowNameOf = (
  workflow: EventTriggerInput["workflows"][number],
): Input<string> => {
  // Resource references are Output proxies; inspect their type before reading fields.
  if (isWorkflowResource(workflow)) {
    return workflow.workflowName;
  }
  if (isWorkflowBinding(workflow)) {
    return workflow.workflowName;
  }
  return workflow;
};

const normalizeEventTriggersProps = (
  props: EventTriggersInput,
): PropsInput<EventTriggersProps> => ({
  ...props,
  triggers: props.triggers.map((trigger) => ({
    ...trigger,
    workflows: trigger.workflows.map(workflowNameOf),
  })),
});

/**
 * A Worker's event triggers: Cloudflare platform events, such as a push to
 * an Artifacts repository, that each start an instance of a Workflow the
 * Worker hosts, with the event as the instance's params. No Queue sits in
 * between. This is wrangler's `triggers.events`.
 *
 * The triggers belong to the script and are replaced as one list, so a
 * script has one `EventTriggers` resource. Its Workflows must exist first:
 * pass their bindings or resources (rather than names) so the triggers
 * deploy after them. Destroy clears the script's triggers.
 * ### Starting a Workflow on every push
 * **Example:** CI on push to any repository in a namespace
 * ```typescript
 * const worker = yield* Cloudflare.Worker("Ci", {
 *   main: "./src/worker.ts",
 *   env: { CI: Cloudflare.Workflow("Ci", { className: "CiWorkflow" }) },
 * });
 *
 * yield* Cloudflare.Workers.EventTriggers("CiTriggers", {
 *   scriptName: worker.workerName,
 *   triggers: [
 *     {
 *       type: "cf.artifacts.repo.pushed",
 *       filter: { namespace: "my-namespace" },
 *       workflows: [worker.env.CI],
 *     },
 *   ],
 * });
 * ```
 *
 * **Example:** One repository only
 * ```typescript
 * yield* Cloudflare.Workers.EventTriggers("RepoTriggers", {
 *   scriptName: worker.workerName,
 *   triggers: [
 *     {
 *       type: "cf.artifacts.repo.pushed",
 *       filter: { namespace: "my-namespace", repoName: "my-repo" },
 *       workflows: [worker.env.CI],
 *     },
 *   ],
 * });
 * ```
 *
 * ### Reading the event in the Workflow
 * **Example:** The push event as the instance's params
 * ```typescript
 * export default class CiWorkflow extends Cloudflare.Workflow<CiWorkflow>()(
 *   "Ci",
 *   Effect.gen(function* () {
 *     return Effect.fn(function* (event: {
 *       type: "cf.artifacts.repo.pushed";
 *       source: { namespace: string; repoName: string };
 *       payload: {
 *         ref: string; // e.g. "refs/heads/main"
 *         before: string;
 *         after: string;
 *         commits: { id: string; message: string; author: { name: string; email: string } }[];
 *       };
 *     }) {
 *       return { built: event.payload.after };
 *     });
 *   }),
 * ) {}
 * ```
 *
 * @see https://developers.cloudflare.com/artifacts/guides/build-and-deploy-on-push/
 *
 * @resource
 * @product Workers
 * @category Workers & Compute
 */
export const EventTriggers: EventTriggersClass = Object.assign(
  (
    ...args:
      | [
          id: string,
          props:
            | EventTriggersInput
            | Effect.Effect<EventTriggersInput, never, any>,
        ]
      | [methods: Record<string, any>]
  ) => {
    if (typeof args[0] === "object") {
      return Object.assign(EventTriggers, args[0]);
    }
    const [id, props] = args as [
      string,
      EventTriggersInput | Effect.Effect<EventTriggersInput, never, any>,
    ];
    // Resource supplies Self while evaluating Effect-valued props.
    return Effect.isEffect(props)
      ? EventTriggersResource(
          id,
          Effect.map(props, normalizeEventTriggersProps),
        )
      : EventTriggersResource(id, normalizeEventTriggersProps(props));
  },
  EventTriggersResource,
  Effectable.Prototype({
    label: `Resource<${TypeId}>`,
    evaluate: (): Effect.Effect<EventTriggersConstructor> =>
      Effect.succeed(EventTriggers),
  }),
) as EventTriggersClass;

/**
 * Returns true if the given value is an EventTriggers resource.
 */
export const isEventTriggers = (value: unknown): value is EventTriggers =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const EventTriggersProvider = () =>
  Provider.succeed(EventTriggersResource, {
    stables: ["accountId", "scriptName"],
    diff: Effect.fn(function* ({ olds, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if ((output?.accountId ?? accountId) !== accountId) {
        return { action: "replace" } as const;
      }
      // The triggers belong to the script: another script is another list.
      const oldScript = output?.scriptName ?? olds?.scriptName;
      if (
        oldScript !== undefined &&
        "scriptName" in news &&
        news.scriptName !== oldScript
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ olds, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;
      const scriptName = output?.scriptName ?? olds?.scriptName;
      if (scriptName === undefined) return undefined;
      const observed = yield* getTriggers(acct, scriptName);
      if (output !== undefined) return observed;
      // Cold read: a script with no triggers has nothing to own; triggers
      // someone else set (wrangler, the dashboard) need --adopt.
      return observed.triggers.length === 0 ? undefined : Unowned(observed);
    }),
    reconcile: Effect.fn(function* ({ news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;

      // Observe the script's live list; sync only when it differs.
      const observed = yield* getTriggers(acct, news.scriptName);
      const desired = news.triggers.map(normalizeTrigger);
      if (sameTriggers(observed.triggers, desired)) {
        return observed;
      }

      const stored = yield* workers
        .putScriptEventTriggers({
          accountId: acct,
          scriptName: news.scriptName,
          body: desired.map((trigger) => toWire(trigger, news.scriptName)),
        })
        .pipe(
          // A target Workflow deployed in the same run can lag its script's upload.
          Effect.retry({
            while: (error) => error._tag === "EventTriggerWorkflowNotFound",
            schedule: Schedule.spaced("2 seconds"),
            times: 8,
          }),
        );
      return toAttributes(stored, acct);
    }),
    delete: Effect.fn(function* ({ output }) {
      // Clearing is idempotent: a script with no triggers, or none at all, answers the same.
      yield* workers.putScriptEventTriggers({
        accountId: output.accountId,
        scriptName: output.scriptName,
        body: [],
      });
    }),
  });

const getTriggers = (accountId: string, scriptName: string) =>
  workers
    .getScriptEventTriggers({ accountId, scriptName })
    .pipe(Effect.map((stored) => toAttributes(stored, accountId)));

const normalizeTrigger = (trigger: EventTrigger): EventTrigger => ({
  type: trigger.type,
  ...(trigger.filter?.namespace === undefined &&
  trigger.filter?.repoName === undefined
    ? {}
    : {
        filter: {
          ...(trigger.filter.namespace === undefined
            ? {}
            : { namespace: trigger.filter.namespace }),
          ...(trigger.filter.repoName === undefined
            ? {}
            : { repoName: trigger.filter.repoName }),
        },
      }),
  workflows: [...trigger.workflows].sort(),
});

const toWire = (
  trigger: EventTrigger,
  scriptName: string,
): workers.EventTrigger => ({
  type: trigger.type,
  ...(trigger.filter === undefined ? {} : { filter: trigger.filter }),
  targets: trigger.workflows.map((workflowName) => ({
    type: "workflow",
    workflowName,
    scriptName,
  })),
});

const toAttributes = (
  stored: workers.ScriptEventTriggers,
  accountId: string,
): EventTriggersAttributes => ({
  accountId,
  scriptName: stored.scriptName,
  triggers: stored.triggers.map((trigger) =>
    normalizeTrigger({
      type: trigger.type as ArtifactsEventType,
      filter: {
        namespace: trigger.filter?.namespace ?? undefined,
        repoName: trigger.filter?.repoName ?? undefined,
      },
      workflows: trigger.targets.map((target) => target.workflowName),
    }),
  ),
});

const canonical = (triggers: readonly EventTrigger[]) =>
  triggers.map((trigger) => JSON.stringify(trigger)).sort();

const sameTriggers = (
  observed: readonly EventTrigger[],
  desired: readonly EventTrigger[],
) => canonical(observed).join("\n") === canonical(desired).join("\n");
