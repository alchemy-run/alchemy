/**
 * Shared lifecycle of the two alert group APIs: `alertgroups` (PromQL) and
 * `logs-alertgroups` (LogQL) have the same shape. Each resource supplies an
 * {@link AlertGroupApi} and keeps its own props, attributes and JSDoc.
 */
import { Unowned } from "alchemy/AdoptPolicy";
import * as Effect from "effect/Effect";
import { StackitEnvironment } from "../../Environment.ts";
import { hasUnresolvedTrigger, rawProp, triggerProps } from "../../internal/diff.ts";
import { waitFor, waitUntilGone } from "../../internal/wait.ts";
import {
  CONFIG_DELETE_TIMEOUT,
  CONFIG_TIMEOUT,
  generatedName,
  isGeneratedName,
  isInstanceGone,
  listOwnedInstances,
  matches,
  type InstanceScope,
} from "../internal.ts";

/** How often a group is evaluated when `interval` is omitted (the API's default). */
const DEFAULT_INTERVAL = "60s";

/** One rule of an alert group: an alerting rule (`alert`) or a recording rule (`record`). */
export interface AlertGroupRule {
  /**
   * Name of the alert, unique in the group, of `a-zA-Z0-9-`. Makes this an alerting
   * rule. Either this or `record`.
   */
  alert?: string;
  /**
   * Name of the metric to record, unique in the group, of `a-zA-Z0-9:_`. Makes this a
   * recording rule. Either this or `alert`.
   */
  record?: string;
  /** The expression to evaluate. */
  expr: string;
  /** How long the expression has to hold before an alert fires. Alerting rules only. */
  for?: string;
  /** Labels to add or overwrite, at most 10. */
  labels?: Record<string, string>;
  /** Annotations of the alert, at most 5. Alerting rules only. */
  annotations?: Record<string, string>;
}

export interface AlertGroupLifecycleProps {
  instanceId: string;
  name?: string;
  interval?: string;
  rules: AlertGroupRule[];
  projectId?: string;
}

export interface AlertGroupLifecycleAttributes {
  name: string;
  instanceId: string;
  projectId: string;
  interval: string | undefined;
  rules: AlertGroupRule[];
}

/** What the API answers for a group. */
export interface LiveAlertGroup {
  readonly name: string;
  readonly interval?: string;
  readonly rules: ReadonlyArray<{
    readonly alert?: string;
    readonly record?: string;
    readonly expr: string;
    readonly for?: string;
    readonly labels?: { readonly [key: string]: string | undefined };
    readonly annotations?: { readonly [key: string]: string | undefined };
  }>;
}

/** One alert group API, with its typed tags handled. */
export interface AlertGroupApi<E, R> {
  /** The group; `undefined` on the typed not-found error. */
  get: (scope: InstanceScope, name: string) => Effect.Effect<LiveAlertGroup | undefined, E, R>;
  list: (scope: InstanceScope) => Effect.Effect<ReadonlyArray<LiveAlertGroup>, E, R>;
  create: (
    scope: InstanceScope,
    name: string,
    interval: string,
    rules: AlertGroupRule[],
  ) => Effect.Effect<unknown, E, R>;
  update: (
    scope: InstanceScope,
    name: string,
    interval: string,
    rules: AlertGroupRule[],
  ) => Effect.Effect<unknown, E, R>;
  /** Delete a group; the typed not-found error counts as done. */
  remove: (scope: InstanceScope, name: string) => Effect.Effect<void, E, R>;
}

const definedEntries = (record: { readonly [key: string]: string | undefined } | undefined) =>
  Object.fromEntries(
    Object.entries(record ?? {}).flatMap(([key, value]) =>
      value === undefined ? [] : [[key, value] as const],
    ),
  );

const toAttrs = (scope: InstanceScope, group: LiveAlertGroup): AlertGroupLifecycleAttributes => ({
  name: group.name,
  instanceId: scope.instanceId,
  projectId: scope.projectId,
  interval: group.interval,
  rules: group.rules.map((rule) => ({
    ...(rule.alert !== undefined ? { alert: rule.alert } : {}),
    ...(rule.record !== undefined ? { record: rule.record } : {}),
    expr: rule.expr,
    ...(rule.for !== undefined ? { for: rule.for } : {}),
    labels: definedEntries(rule.labels),
    annotations: definedEntries(rule.annotations),
  })),
});

/**
 * What the group should be, in the shape of the live one. A rule's unset `labels`,
 * `annotations` and `for` are written out so that removing them counts as drift. A
 * recording rule takes neither `for` nor `annotations`.
 */
const desiredGroup = (interval: string, rules: ReadonlyArray<AlertGroupRule>) => ({
  interval,
  rules: rules.map((rule) => ({
    alert: rule.alert,
    record: rule.record,
    expr: rule.expr,
    labels: rule.labels ?? {},
    ...(rule.record === undefined
      ? { for: rule.for ?? "0s", annotations: rule.annotations ?? {} }
      : {}),
  })),
});

/** The lifecycle of an alert group. */
export const makeAlertGroupLifecycle = <E, R>(options: {
  /** What errors call a group, e.g. `STACKIT Observability alert group`. */
  readonly label: string;
  readonly api: AlertGroupApi<E, R>;
}) => {
  const { api, label } = options;

  const removeAndWait = (scope: InstanceScope, name: string) =>
    Effect.gen(function* () {
      yield* api.remove(scope, name);
      yield* waitUntilGone({
        resource: `${label} ${name}`,
        read: api.get(scope, name),
        timeout: CONFIG_DELETE_TIMEOUT,
      });
    });

  return {
    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      const projectId = env.projectId;
      const instances = yield* listOwnedInstances(projectId);
      const attrs: AlertGroupLifecycleAttributes[] = [];
      for (const instance of instances) {
        const scope = { projectId, instanceId: instance.id };
        if (yield* isInstanceGone(scope)) continue;
        const groups = yield* api.list(scope);
        for (const group of groups) {
          if (isGeneratedName(group.name)) attrs.push(toAttrs(scope, group));
        }
      }
      return attrs;
    }),

    diff: Effect.fn(function* (news: unknown, output: AlertGroupLifecycleAttributes) {
      // An unresolved value can resolve to the one the group already has, and an
      // explicit name can't exist twice on an instance. A generated name holds the
      // generation.
      if (
        hasUnresolvedTrigger<AlertGroupLifecycleProps>(news, ["instanceId", "projectId", "name"])
      ) {
        return {
          action: "replace",
          deleteFirst: rawProp<AlertGroupLifecycleProps>(news, "name") !== undefined,
        } as const;
      }
      const env = yield* StackitEnvironment.current;
      const resolved = triggerProps<AlertGroupLifecycleProps>(news);
      if (
        resolved.instanceId !== output.instanceId ||
        (resolved.projectId ?? env.projectId) !== output.projectId ||
        (resolved.name !== undefined && resolved.name !== output.name)
      ) {
        return { action: "replace", deleteFirst: false } as const;
      }
      // Everything else updates in place (engine default: props changed).
      return undefined;
    }),

    read: Effect.fn(function* (
      id: string,
      olds: AlertGroupLifecycleProps | undefined,
      output: AlertGroupLifecycleAttributes | undefined,
      previous: AlertGroupLifecycleAttributes | undefined,
    ) {
      const env = yield* StackitEnvironment.current;
      const projectId = output?.projectId ?? olds?.projectId ?? env.projectId;
      const instanceId = output?.instanceId ?? olds?.instanceId;
      if (instanceId === undefined) return undefined;
      const scope = { projectId, instanceId };
      if (yield* isInstanceGone(scope)) return undefined;
      const generated = yield* generatedName(id);
      const name = output?.name ?? olds?.name ?? generated;
      const group = yield* api.get(scope, name);
      if (group === undefined) return undefined;
      const attrs = toAttrs(scope, group);
      // A generated name holds this generation. An explicit one proves nothing without
      // state, unless it is the generation being replaced, at the same scope.
      const isPrevious =
        previous?.name === name &&
        previous.instanceId === instanceId &&
        previous.projectId === projectId;
      return output !== undefined || name === generated || isPrevious ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* (
      id: string,
      news: AlertGroupLifecycleProps,
      output: AlertGroupLifecycleAttributes | undefined,
    ) {
      const env = yield* StackitEnvironment.current;
      const projectId = news.projectId ?? output?.projectId ?? env.projectId;
      const scope = { projectId, instanceId: news.instanceId };
      const generated = yield* generatedName(id);
      const name = news.name ?? output?.name ?? generated;
      const interval = news.interval ?? DEFAULT_INTERVAL;
      const resource = `${label} ${name}`;
      const desired = desiredGroup(interval, news.rules);

      // 1. Observe
      const observed = yield* api.get(scope, name);

      // 2. Ensure — asynchronous: wait until the group reads back.
      const created = observed === undefined;
      if (created) yield* api.create(scope, name, interval, news.rules);

      const converge = Effect.gen(function* () {
        const current = yield* waitFor({
          resource,
          read: api.get(scope, name),
          ready: (group) => group !== undefined,
          state: (group) => (group === undefined ? "not visible yet" : "ready"),
          timeout: CONFIG_TIMEOUT,
        });

        // 3. Sync — the whole group, only when it differs from what is live.
        if (!matches(desired, current)) yield* api.update(scope, name, interval, news.rules);

        // 4. Return — the write answers 202 and reports no status: only the desired
        // values finish the wait.
        const final = yield* waitFor({
          resource,
          read: api.get(scope, name),
          ready: (group) => group !== undefined && matches(desired, group),
          state: (group) => (group === undefined ? "not visible yet" : "applying"),
          timeout: CONFIG_TIMEOUT,
        });
        // `ready` only passes a group.
        return toAttrs(scope, final as LiveAlertGroup);
      });

      // A group state never hears of would read as unowned on the next deploy if it has
      // an explicit name.
      return yield* created
        ? converge.pipe(Effect.onError(() => removeAndWait(scope, name).pipe(Effect.ignore)))
        : converge;
    }),

    delete: Effect.fn(function* (output: AlertGroupLifecycleAttributes) {
      const scope = { projectId: output.projectId, instanceId: output.instanceId };
      if (yield* isInstanceGone(scope)) return;
      yield* removeAndWait(scope, output.name);
    }),
  };
};
