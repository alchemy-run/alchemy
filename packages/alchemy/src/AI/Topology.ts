/**
 * The org graph, derived — not configured (org-chat §1). Terms are pure
 * data (template + refs), so "what channels exist, who's in them, what
 * can they use" is a static fold over interpolation: a process's
 * children are its interpolated Agent/Process refs (including refs
 * nested one level down in control-ref templates), tools are its
 * capabilities, and a kind instance carries its `~alchemy/Subkind` and
 * `meta` for the app to switch rendering on. The UI's sidebar is this
 * fold, served as JSON.
 */
import { isAgent } from "./Agent.ts";
import { isProcess } from "./Process.ts";
import { renderTemplate } from "./Render.ts";
import { isTool } from "./Tool.ts";

export interface TopologyNode {
  readonly name: string;
  readonly kind: "process" | "agent" | "tool";
  /** The kind's name for `AI.Process(name, definition)` instances. */
  readonly subkind?: string;
  /** The kind's user-defined meta, passed through untouched. */
  readonly meta?: unknown;
  /** The rendered charter/description prose. */
  readonly prose: string;
  /** Interpolated Agent/Process refs — the members/sub-processes. */
  readonly children: ReadonlyArray<TopologyNode>;
  /** Interpolated Tool refs — the capabilities. */
  readonly tools: ReadonlyArray<string>;
}

interface TermLike {
  readonly "~alchemy/Name": string;
  readonly template: TemplateStringsArray | ReadonlyArray<string>;
  readonly refs: ReadonlyArray<unknown>;
  readonly "~alchemy/Subkind"?: string;
  readonly "~alchemy/Meta"?: unknown;
}

/** Refs nested one level down in control-ref templates (halt/check/fold). */
const nestedRefs = (ref: unknown): ReadonlyArray<unknown> => {
  if (typeof ref !== "object" || ref === null) return [];
  const record = ref as { refs?: unknown; agent?: unknown };
  const inner = Array.isArray(record.refs) ? record.refs : [];
  return record.agent !== undefined ? [record.agent, ...inner] : inner;
};

const nodeOf = (term: TermLike, kind: TopologyNode["kind"]): TopologyNode => {
  const refs = [
    ...term.refs,
    ...term.refs.flatMap((ref) =>
      isAgent(ref) || isProcess(ref) || isTool(ref) ? [] : nestedRefs(ref),
    ),
  ];
  return {
    name: term["~alchemy/Name"],
    kind,
    ...(term["~alchemy/Subkind"] !== undefined && {
      subkind: term["~alchemy/Subkind"],
    }),
    ...(term["~alchemy/Meta"] !== undefined && { meta: term["~alchemy/Meta"] }),
    prose: renderTemplate(term.template, term.refs),
    children: refs.flatMap((ref) =>
      isProcess(ref)
        ? [nodeOf(ref as unknown as TermLike, "process")]
        : isAgent(ref)
          ? [nodeOf(ref as unknown as TermLike, "agent")]
          : [],
    ),
    tools: refs.flatMap((ref) =>
      isTool(ref)
        ? [(ref as { "~alchemy/Name": string })["~alchemy/Name"]]
        : [],
    ),
  };
};

/**
 * Fold root terms into the org graph. Roots may be processes or agents;
 * shared children appear under each parent that interpolates them
 * (membership, not ownership).
 */
export const topology = (
  ...roots: ReadonlyArray<unknown>
): ReadonlyArray<TopologyNode> =>
  roots.flatMap((root) =>
    isProcess(root)
      ? [nodeOf(root as unknown as TermLike, "process")]
      : isAgent(root)
        ? [nodeOf(root as unknown as TermLike, "agent")]
        : [],
  );
