/**
 * Shared lifecycle of the ten Observability checks (`cert-checks`, `http-checks`,
 * ...). They all have the same three operations: `create`, `list` and `delete` by a
 * server-assigned id, with no get and no update, so everything about a check replaces
 * it. Each resource supplies a {@link CheckApi} and keeps its own props, attributes
 * and JSDoc.
 *
 * Checks have no name and no labels. The id in state is what makes a check ours: one
 * found only by its target is reported as unowned.
 */
import { Unowned } from "alchemy/AdoptPolicy";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { StackitEnvironment } from "../../Environment.ts";
import { hasUnresolvedTrigger, triggerProps } from "../../internal/diff.ts";
import { secretsDiffer } from "../../internal/equal.ts";
import { waitFor, waitUntilGone } from "../../internal/wait.ts";
import {
  CONFIG_DELETE_TIMEOUT,
  CONFIG_TIMEOUT,
  isInstanceGone,
  listOwnedInstances,
  type InstanceScope,
} from "../internal.ts";

/** The props every check takes. `target` is the prop each check names for itself. */
export interface CheckProps {
  instanceId: string;
  username?: string;
  password?: string | Redacted.Redacted<string>;
  projectId?: string;
}

/** The attributes every check has. Passwords never get in. */
export interface CheckIdentity {
  checkId: string;
  instanceId: string;
  projectId: string;
}

/** What the API answers for a check. */
export interface LiveCheck {
  readonly id: string;
  readonly username?: string;
}

/** One check's operations, with its target read and written by `target`. */
export interface CheckApi<Props extends CheckProps, Item extends LiveCheck, E, R> {
  /** Every check of this kind on the instance. */
  list: (scope: InstanceScope) => Effect.Effect<ReadonlyArray<Item>, E, R>;
  /** Create a check. The answer holds the new one when the API names it. */
  create: (scope: InstanceScope, props: Props) => Effect.Effect<Item | undefined, E, R>;
  /** Delete a check by id. */
  remove: (scope: InstanceScope, checkId: string) => Effect.Effect<unknown, E, R>;
  /** The target of the desired check. */
  targetOf: (props: Props) => string;
  /** The target of a live check. */
  liveTargetOf: (item: Item) => string;
}

/** The lifecycle of a check, which has nothing to update. */
export const makeCheckLifecycle = <
  Props extends CheckProps,
  Item extends LiveCheck,
  Attrs extends CheckIdentity,
  E,
  R,
>(options: {
  /** What errors call a check, e.g. `STACKIT Observability HTTP check`. */
  readonly label: string;
  readonly api: CheckApi<Props, Item, E, R>;
  /** Prop names of the check's target, for the unresolved check in `diff`. */
  readonly targetProp: string;
  /** The attributes of a live check. */
  readonly attributes: (scope: InstanceScope, item: Item) => Attrs;
  /** The target in the attributes. */
  readonly attrTargetOf: (attrs: Attrs) => string;
}) => {
  const { api, label } = options;

  const removeAndWait = (scope: InstanceScope, checkId: string) =>
    Effect.gen(function* () {
      // These deletes document no 404, so a check already gone has to be seen by listing.
      const before = yield* api.list(scope);
      if (!before.some((item) => item.id === checkId)) return;
      yield* api.remove(scope, checkId);
      yield* waitUntilGone({
        resource: `${label} ${checkId}`,
        read: api
          .list(scope)
          .pipe(Effect.map((items) => items.find((item) => item.id === checkId))),
        timeout: CONFIG_DELETE_TIMEOUT,
      });
    });

  return {
    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      const projectId = env.projectId;
      const instances = yield* listOwnedInstances(projectId);
      const attrs: Attrs[] = [];
      for (const instance of instances) {
        const scope = { projectId, instanceId: instance.id };
        if (yield* isInstanceGone(scope)) continue;
        const items = yield* api.list(scope);
        attrs.push(...items.map((item) => options.attributes(scope, item)));
      }
      return attrs;
    }),

    diff: Effect.fn(function* (news: unknown, olds: Props | undefined, output: Attrs) {
      // A check can't be updated. An unresolved value can resolve to the one the check
      // already has: delete first, so `read` can't take the old check for the new one.
      if (
        hasUnresolvedTrigger<Record<string, unknown>>(news, [
          "instanceId",
          "projectId",
          "username",
          "password",
          options.targetProp,
        ])
      ) {
        return { action: "replace", deleteFirst: true } as const;
      }
      const env = yield* StackitEnvironment.current;
      const resolved = triggerProps<Props>(news);
      if (
        resolved.instanceId !== output.instanceId ||
        (resolved.projectId ?? env.projectId) !== output.projectId ||
        // Against the last props when there are any: the API may print a target its own way.
        api.targetOf(resolved) !==
          (olds !== undefined ? api.targetOf(olds) : options.attrTargetOf(output))
      ) {
        return { action: "replace", deleteFirst: false } as const;
      }
      // Compare against the last props: `list` would hand back the password, but it is
      // never kept in the attributes.
      if (
        olds !== undefined &&
        (olds.username !== resolved.username || secretsDiffer(olds.password, resolved.password))
      ) {
        return { action: "replace", deleteFirst: true } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* (
      olds: Props | undefined,
      output: Attrs | undefined,
      previous: Attrs | undefined,
    ) {
      const env = yield* StackitEnvironment.current;
      const projectId = output?.projectId ?? olds?.projectId ?? env.projectId;
      const instanceId = output?.instanceId ?? olds?.instanceId;
      if (instanceId === undefined) return undefined;
      const scope = { projectId, instanceId };
      if (yield* isInstanceGone(scope)) return undefined;
      const items = yield* api.list(scope);
      if (output !== undefined) {
        const byId = items.find((item) => item.id === output.checkId);
        if (byId !== undefined) return options.attributes(scope, byId);
      }
      const target =
        output !== undefined ? options.attrTargetOf(output) : olds && api.targetOf(olds);
      if (target === undefined) return undefined;
      const found = items.find((item) => api.liveTargetOf(item) === target);
      if (found === undefined) return undefined;
      const attrs = options.attributes(scope, found);
      // An id is only unique in its instance, so the replaced generation has to match by both.
      const isPrevious =
        previous?.checkId === found.id &&
        previous.instanceId === instanceId &&
        previous.projectId === projectId;
      return isPrevious ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* (news: Props, output: Attrs | undefined) {
      const env = yield* StackitEnvironment.current;
      const projectId = news.projectId ?? output?.projectId ?? env.projectId;
      const scope = { projectId, instanceId: news.instanceId };
      // 1. Observe — the id in `output` only speaks for this check on the same instance.
      const items = yield* api.list(scope);
      const known =
        output?.instanceId === news.instanceId && output.projectId === projectId
          ? items.find((item) => item.id === output.checkId)
          : undefined;
      if (known !== undefined) return options.attributes(scope, known);
      // 2. Ensure. There is nothing to sync: a check has no update.
      const created = yield* api.create(scope, news);
      if (created !== undefined) return options.attributes(scope, created);
      // The schema calls the new check optional: find it by its target.
      const target = api.targetOf(news);
      const found = yield* waitFor({
        resource: `${label} for ${target}`,
        read: api
          .list(scope)
          .pipe(Effect.map((all) => all.find((item) => api.liveTargetOf(item) === target))),
        ready: (item) => item !== undefined,
        state: (item) => (item === undefined ? "not visible yet" : "ready"),
        timeout: CONFIG_TIMEOUT,
      });
      // `ready` only passes a check.
      return options.attributes(scope, found as Item);
    }),

    delete: Effect.fn(function* (output: Attrs) {
      const scope = { projectId: output.projectId, instanceId: output.instanceId };
      if (yield* isInstanceGone(scope)) return;
      yield* removeAndWait(scope, output.checkId);
    }),
  };
};
