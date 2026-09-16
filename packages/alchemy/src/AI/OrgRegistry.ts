import * as Context from "effect/Context";

/**
 * THE ORG REGISTRY — the organization, derived, never re-declared.
 *
 * Every Agent, Skill, and Group Layer that BUILDS registers its
 * static declaration here (the template and refs riding the Layer as
 * `Teaching`): the driver's `construct` registers the agent when the
 * charter runs, `AI.layer` registers the skill/group when its bundle
 * builds. The same code path runs at plan time in the deploy process
 * and once per isolate at boot, so a host serving the registry serves
 * exactly the structure it deployed — a roster kept by hand would
 * drift; this one CANNOT.
 *
 * OPTIONAL, like `Binding.AcquisitionRegistry`: no registry provided
 * means registration is a no-op. Rows de-dupe on kind + name.
 */
export interface OrgNode {
  readonly kind: "Agent" | "Skill" | "Group";
  readonly name: string;
  /** The defining file, when declared with `import.meta`. */
  readonly source?: string;
  /** The declaration — the same template the model reads. */
  readonly template: TemplateStringsArray;
  readonly refs: ReadonlyArray<unknown>;
  /** Agent-only: the model KEY its turn hook selects
   *  (`AI.selectModel` — probed once where the charter runs). */
  readonly model?: string;
}

export class OrgRegistry extends Context.Service<
  OrgRegistry,
  {
    readonly register: (node: OrgNode) => void;
    readonly list: () => ReadonlyArray<OrgNode>;
  }
>()("alchemy/AI/OrgRegistry") {}

/** An in-memory {@link OrgRegistry} implementation. */
export const makeOrgRegistry = (): {
  register: (node: OrgNode) => void;
  list: () => ReadonlyArray<OrgNode>;
} => {
  const rows = new Map<string, OrgNode>();
  return {
    register: (node) => {
      rows.set(`${node.kind}:${node.name}`, node);
    },
    list: () => [...rows.values()],
  };
};
