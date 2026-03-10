import * as Output from "./Output.ts";
import type { BindingNode } from "./Plan.ts";
import type { ResourceBinding, ResourceLike } from "./Resource.ts";

export type Diff = NoopDiff | UpdateDiff | ReplaceDiff;

export interface NoopDiff {
  action: "noop";
  stables?: undefined;
}

export interface UpdateDiff {
  action: "update";
  /** properties that won't change as part of this update */
  stables?: string[];
}

export interface ReplaceDiff {
  action: "replace";
  deleteFirst?: boolean;
  stables?: undefined;
}

export const somePropsAreDifferent = <Props extends Record<string, any>>(
  olds: Props,
  news: Props,
  props: (keyof Props)[],
) => {
  for (const prop of props) {
    if (olds[prop] !== news[prop]) {
      return true;
    }
  }
  return false;
};

export const anyPropsAreDifferent = <Props extends Record<string, any>>(
  olds: Props,
  news: Props,
) => {
  for (const prop in olds) {
    if (olds[prop] !== news[prop]) {
      return true;
    }
  }
  for (const prop in news) {
    if (!(prop in olds)) {
      return true;
    }
  }
  return false;
};

export const havePropsChanged = <R extends ResourceLike>(
  oldProps: R["Props"] | undefined,
  newProps: R["Props"],
) =>
  Output.hasOutputs(newProps) ||
  // TODO(sam): sort keys and deep compare
  JSON.stringify(canonicalize(oldProps ?? {})) !==
    JSON.stringify(canonicalize(newProps ?? {}));

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
};

export const diffBindings = (
  oldBindings: ResourceBinding[],
  newBindings: ResourceBinding[],
): BindingNode[] => {
  const oldMap = new Map(oldBindings.map((b) => [b.sid, b]));
  const newMap = new Map(newBindings.map((b) => [b.sid, b]));
  return [
    ...Array.from(oldMap)
      .filter(([sid]) => !newMap.has(sid))
      .map(([sid, old]) => ({
        sid,
        namespace: old.namespace,
        action: "delete" as const,
        data: old.data,
      })),
    ...Array.from(newMap).map(([sid, binding]) => {
      const old = oldMap.get(sid);
      return {
        sid,
        namespace: binding.namespace,
        action: (!old
          ? "create"
          : havePropsChanged(old.data, binding.data)
            ? "update"
            : "noop") as BindingNode["action"],
        data: binding.data,
      };
    }),
  ];
};
