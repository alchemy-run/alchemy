import * as AI from "alchemy/AI";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

/**
 * THE ORG GRAPH — the company's structure as data, DERIVED, never
 * re-declared.
 *
 * Every Agent, Skill, and Group Layer that builds registers its
 * static declaration (`Teaching` — the template and refs the driver
 * runs) into the ambient `AI.OrgRegistry`; this module only PROJECTS
 * those rows. There is no roster here: the same Layer builds that
 * boot the deployed Worker populate the registry, so the graph served
 * is exactly the org deployed — a hand-kept table would drift; this
 * one cannot.
 *
 * Deliberately NO per-tool permission table: a tool's reach is not
 * statically knowable — it may depend on a `Context.Service` whose
 * Layer (with its own bindings and resources) is provided to the
 * AGENT, outside the tool's own init, so any attribution of bindings
 * to tools would be partial and misleading.
 */

export interface OrgTool {
  readonly name: string;
  /** The tool's prose (its tagged template, rendered). */
  readonly description: string;
  /** `static` — a module-scope ToolDef; `class` — a tagged contract
   *  with Layer-provided physics. */
  readonly kind: "static" | "class";
  readonly params: ReadonlyArray<string>;
  readonly outputs: ReadonlyArray<string>;
  readonly errors: ReadonlyArray<string>;
}

export interface OrgSkill {
  readonly name: string;
  readonly source: string | undefined;
  /** The teaching, rendered — the same text the model reads. */
  readonly teaching: string;
  readonly tools: ReadonlyArray<string>;
}

export interface OrgAgent {
  readonly name: string;
  readonly slug: string;
  readonly source: string | undefined;
  /** The model the agent's turn hook pins (`AI.selectModel`),
   *  probed where the charter ran. */
  readonly model: { readonly id: string; readonly label: string } | undefined;
  /** The charter, rendered — the same prose the model reads. */
  readonly charter: string;
  readonly tools: ReadonlyArray<OrgTool>;
  /** The granted skills with their runtime switch (the gate's state). */
  readonly skills: ReadonlyArray<{ name: string; enabled: boolean }>;
  readonly groups: ReadonlyArray<string>;
}

export interface OrgGroup {
  readonly name: string;
  readonly slug: string;
  readonly source: string | undefined;
  readonly chart: string;
  readonly members: ReadonlyArray<string>;
}

export interface OrgGraph {
  readonly groups: ReadonlyArray<OrgGroup>;
  readonly agents: ReadonlyArray<OrgAgent>;
  readonly skills: ReadonlyArray<OrgSkill>;
}

const nameOf = (term: unknown): string =>
  (term as { "~alchemy/Name": string })["~alchemy/Name"];

/** The registry's model key (`root/Haiku`) as the UI's `{ id, label }`. */
const modelOf = (
  key: string | undefined,
): OrgAgent["model"] =>
  key === undefined
    ? undefined
    : { id: key, label: key.slice(key.lastIndexOf("/") + 1) };

/* ── marked prose: every splice a FIRST-CLASS reference ──────────────
 *
 * The model reads `\`name\`` mentions (AI.render — byte-stable, plain);
 * the MIRROR reads the same templates with every splice rendered as a
 * TYPED reference — a markdown link on the `/ref/<kind>/<name>` path
 * the UI draws as a pill with the kind's icon (a tool wears a wrench
 * the way "@manager" wears the mention chip). A path, not a custom
 * scheme: the markdown renderer's link security blocks unknown
 * protocols. */

const mark = (kind: string, name: string): string =>
  `[${name}](/ref/${kind}/${encodeURIComponent(name)})`;

const markRef = (ref: unknown): string => {
  if (AI.isToolDef(ref)) return mark("tool", ref.tool["~alchemy/Name"]);
  if (AI.isToolImpl(ref)) return mark("tool", ref.tool["~alchemy/Name"]);
  if (AI.isTool(ref)) return mark("tool", nameOf(ref));
  if (AI.isSkill(ref)) return mark("skill", nameOf(ref));
  if (AI.isAgent(ref)) return mark("agent", AI.memberSlug(nameOf(ref)));
  if (AI.isGroup(ref)) return mark("group", nameOf(ref));
  if (AI.isThing(ref)) return mark("param", nameOf(ref));
  if (AI.isIn(ref)) {
    return ref.things.map((thing) => mark("param", nameOf(thing))).join(", ");
  }
  if (AI.isOut(ref)) {
    return ref.things.map((thing) => mark("output", nameOf(thing))).join(", ");
  }
  if (AI.isErrorTerm(ref)) return mark("error", AI.errorTag(ref));
  if (AI.isSource(ref)) {
    const source = ref as { path?: string; "~alchemy/Name": string };
    return mark("source", source.path ?? source["~alchemy/Name"]);
  }
  if (AI.isFragment(ref)) return renderMarked(ref.template, ref.refs);
  if (Effect.isEffect(ref)) return "…";
  return String(ref);
};

/** Render a template with every splice as a typed reference link. */
const renderMarked = (
  template: TemplateStringsArray,
  refs: ReadonlyArray<unknown>,
): string => {
  const parts = AI.dedentTemplate(template);
  let out = parts[0] ?? "";
  for (let index = 0; index < refs.length; index++) {
    out += markRef(refs[index]) + (parts[index + 1] ?? "");
  }
  return out.trim();
};

/** One tool term's projection: prose, schema summary, declared errors. */
const toolEntry = (
  term: AI.Tool<string, any[]>,
  kind: OrgTool["kind"],
): OrgTool => {
  const params: string[] = [];
  const outputs: string[] = [];
  const errors: string[] = [];
  for (const ref of term.refs) {
    if (AI.isThing(ref)) params.push(nameOf(ref));
    else if (AI.isIn(ref)) params.push(...ref.things.map(nameOf));
    else if (AI.isOut(ref)) outputs.push(...ref.things.map(nameOf));
    else if (AI.isErrorTerm(ref)) errors.push(AI.errorTag(ref));
  }
  return {
    name: nameOf(term),
    description: renderMarked(term.template, term.refs),
    kind,
    params,
    outputs,
    errors,
  };
};

/** Build the graph from the registered declarations and the stored
 *  skill switch-offs (`agent/skill`). */
export const buildOrgGraph = (
  nodes: ReadonlyArray<AI.OrgNode>,
  disabled: ReadonlySet<string> = new Set(),
): OrgGraph => {
  const groups: OrgGroup[] = nodes
    .filter((node) => node.kind === "Group")
    .map((node) => ({
      name: node.name,
      slug: AI.memberSlug(node.name),
      source: node.source,
      chart: renderMarked(node.template, node.refs),
      members: node.refs.filter(AI.isAgent).map(nameOf),
    }));

  const skills: OrgSkill[] = nodes
    .filter((node) => node.kind === "Skill")
    .map((node) => ({
      name: node.name,
      source: node.source,
      teaching: renderMarked(node.template, node.refs),
      // a teaching may mention a tool several times — one grant
      tools: [...new Set(node.refs.filter(AI.isTool).map(nameOf))],
    }));

  const agents: OrgAgent[] = nodes
    .filter((node) => node.kind === "Agent")
    .map((node) => {
      const name = node.name;
      // prose may mention a tool several times — one grant per name
      const tools: OrgTool[] = [];
      const seen = new Set<string>();
      const grantedSkills = new Set<string>();
      const grant = (
        term: AI.Tool<string, any[]>,
        kind: OrgTool["kind"],
      ) => {
        const toolName = nameOf(term);
        if (seen.has(toolName)) return;
        seen.add(toolName);
        tools.push(toolEntry(term, kind));
      };
      for (const ref of node.refs) {
        if (AI.isToolDef(ref)) grant(ref.tool, "static");
        else if (AI.isTool(ref)) grant(ref, "class");
        else if (AI.isSkill(ref)) grantedSkills.add(nameOf(ref));
      }
      return {
        name,
        slug: AI.memberSlug(name),
        source: node.source,
        model: modelOf(node.model),
        charter: renderMarked(node.template, node.refs),
        tools,
        skills: [...grantedSkills].map((skill) => ({
          name: skill,
          enabled: !disabled.has(`${name}/${skill}`),
        })),
        groups: groups
          .filter((group) => group.members.includes(name))
          .map((group) => group.name),
      };
    });

  return { groups, agents, skills };
};

/** The graph over the ambient registry (empty without one). */
export const orgGraph: Effect.Effect<OrgGraph> = Effect.gen(function* () {
  const structure = yield* Effect.serviceOption(AI.OrgRegistry);
  return buildOrgGraph(
    Option.isSome(structure) ? structure.value.list() : [],
  );
});
