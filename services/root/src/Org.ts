import * as AI from "alchemy/AI";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Head, HeadLive } from "./Head.ts";
import Root, { RootChart } from "./Root.ts";
import { CharterGuidance, CharterGuidanceGeneral } from "./CharterGuidance.ts";
import { ToolGuidance, ToolGuidanceGeneral } from "./coding/ToolGuidance.ts";
import Engineering, { EngineeringChart } from "./engineering/Group.ts";
import { Engineer, GeneralEngineer } from "./engineering/Engineer.ts";
import { Manager, ManagerLive } from "./engineering/Manager.ts";
import { GeneralReviewer, Reviewer } from "./engineering/Reviewer.ts";
import { OrgGuidance, OrgGuidanceGeneral } from "./OrgGuidance.ts";
import { AwsEmulation, AwsEmulationGeneral } from "./process/AwsEmulation.ts";
import {
  CloudflareEmulation,
  CloudflareEmulationGeneral,
} from "./process/CloudflareEmulation.ts";
import {
  Distillation,
  DistillationGeneral,
} from "./process/Distillation.ts";
import {
  ProviderEngineering,
  ProviderEngineeringGeneral,
} from "./process/ProviderEngineering.ts";
import {
  Verification,
  VerificationGeneral,
} from "./process/Verification.ts";
import {
  SandboxGuidance,
  SandboxGuidanceGeneral,
} from "./sandbox/SandboxGuidance.ts";

/**
 * THE ORG GRAPH — the company's structure as data, walked from the
 * same static declarations the driver runs: every agent's charter is
 * a module-scope template (`Head.make`…``), every group's chart and
 * skill's teaching ride their Layers as `Teaching` statics, and every
 * tool is either a static `ToolDef` or a class tool term. Nothing
 * here executes a charter; the graph IS the code, projected.
 *
 * Permissions come from the ambient `Binding.AcquisitionRegistry`
 * (provided by the Worker): the same Layer builds that construct the
 * agents record every `Binding.Service` acquisition under its org
 * path (agent → skill → tool), so the deployed Worker serves exactly
 * the permission table its own boot proved.
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
  /** The capability acquisitions attributed to this tool. */
  readonly permissions: ReadonlyArray<OrgPermission>;
}

export interface OrgPermission {
  /** The `Binding.Service` key (e.g. `GitHub.GetIssue`). */
  readonly binding: string;
  readonly targets: ReadonlyArray<string>;
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
  readonly model: { readonly id: string; readonly label: string };
  /** The charter, rendered — the same prose the model reads. */
  readonly charter: string;
  readonly tools: ReadonlyArray<OrgTool>;
  readonly skills: ReadonlyArray<string>;
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

/** Every agent pins Haiku today (`AI.selectModel(Haiku)` in its turn
 *  hook); the pin is per agent, so the entry rides the roster. */
const HAIKU = { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" };

interface Teaching {
  readonly template: TemplateStringsArray;
  readonly refs: ReadonlyArray<unknown>;
}

/** The roster — the same exports ApiWorker deploys. */
const AGENTS: ReadonlyArray<{
  cls: { "~alchemy/Name": string; source?: { path?: string } };
  live: Teaching;
  model: typeof HAIKU;
}> = [
  { cls: Head, live: HeadLive, model: HAIKU },
  { cls: Manager, live: ManagerLive, model: HAIKU },
  { cls: Engineer, live: GeneralEngineer, model: HAIKU },
  { cls: Reviewer, live: GeneralReviewer, model: HAIKU },
];

const GROUPS: ReadonlyArray<{
  cls: { "~alchemy/Name": string; source?: { path?: string } };
  chart: Teaching;
}> = [
  { cls: Root, chart: RootChart },
  { cls: Engineering, chart: EngineeringChart },
];

/** Skill class → its General teaching Layer (the org's default). */
const SKILLS: ReadonlyArray<{
  cls: { "~alchemy/Name": string; source?: { path?: string } };
  general: Teaching;
}> = [
  { cls: Verification, general: VerificationGeneral },
  { cls: ProviderEngineering, general: ProviderEngineeringGeneral },
  { cls: Distillation, general: DistillationGeneral },
  { cls: AwsEmulation, general: AwsEmulationGeneral },
  { cls: CloudflareEmulation, general: CloudflareEmulationGeneral },
  { cls: OrgGuidance, general: OrgGuidanceGeneral },
  { cls: CharterGuidance, general: CharterGuidanceGeneral },
  { cls: ToolGuidance, general: ToolGuidanceGeneral },
  { cls: SandboxGuidance, general: SandboxGuidanceGeneral },
];

const nameOf = (term: unknown): string =>
  (term as { "~alchemy/Name": string })["~alchemy/Name"];

const sourceOf = (cls: { source?: { path?: string } }): string | undefined =>
  cls.source?.path;

/** One tool term's projection: prose, schema summary, declared errors. */
const toolEntry = (
  term: AI.Tool<string, any[]>,
  kind: OrgTool["kind"],
  permissions: ReadonlyArray<OrgPermission>,
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
    description: AI.render(term.template, term.refs),
    kind,
    params,
    outputs,
    errors,
    permissions,
  };
};

/** Build the graph — the static structure plus the attributed
 *  acquisitions recorded by the host's Layer builds. */
export const buildOrgGraph = (
  acquisitions: ReadonlyArray<Binding.Acquisition>,
): OrgGraph => {
  /** The acquisitions attributed to one tool (under one agent). */
  const permissionsOf = (
    agent: string,
    tool: string,
  ): ReadonlyArray<OrgPermission> =>
    acquisitions
      .filter(
        (row) =>
          row.path.some(
            (frame) => frame.kind === "Agent" && frame.name === agent,
          ) &&
          row.path.some(
            (frame) => frame.kind === "Tool" && frame.name === tool,
          ),
      )
      .map((row) => ({ binding: row.binding, targets: row.targets }));

  const groups: OrgGroup[] = GROUPS.map((entry) => ({
    name: nameOf(entry.cls),
    slug: AI.memberSlug(nameOf(entry.cls)),
    source: sourceOf(entry.cls),
    chart: AI.render(entry.chart.template, [...entry.chart.refs]),
    members: entry.chart.refs.filter(AI.isAgent).map(nameOf),
  }));

  const skills: OrgSkill[] = SKILLS.map((entry) => ({
    name: nameOf(entry.cls),
    source: sourceOf(entry.cls),
    teaching: AI.render(entry.general.template, [...entry.general.refs]),
    // a teaching may mention a tool several times — one grant
    tools: [...new Set(entry.general.refs.filter(AI.isTool).map(nameOf))],
  }));

  const agents: OrgAgent[] = AGENTS.map((entry) => {
    const name = nameOf(entry.cls);
    // prose may mention a tool several times — one grant per name
    const tools: OrgTool[] = [];
    const seen = new Set<string>();
    const grantedSkills = new Set<string>();
    const grant = (term: AI.Tool<string, any[]>, kind: OrgTool["kind"]) => {
      const toolName = nameOf(term);
      if (seen.has(toolName)) return;
      seen.add(toolName);
      tools.push(toolEntry(term, kind, permissionsOf(name, toolName)));
    };
    for (const ref of entry.live.refs) {
      if (AI.isToolDef(ref)) grant(ref.tool, "static");
      else if (AI.isTool(ref)) grant(ref, "class");
      else if (AI.isSkill(ref)) grantedSkills.add(nameOf(ref));
    }
    return {
      name,
      slug: AI.memberSlug(name),
      source: sourceOf(entry.cls),
      model: entry.model,
      charter: AI.render(entry.live.template, [...entry.live.refs]),
      tools,
      skills: [...grantedSkills],
      groups: groups
        .filter((group) => group.members.includes(name))
        .map((group) => group.name),
    };
  });

  return { groups, agents, skills };
};

/** The graph over the ambient registry (empty permissions without one). */
export const orgGraph: Effect.Effect<OrgGraph> = Effect.map(
  Effect.serviceOption(Binding.AcquisitionRegistry),
  (registry) =>
    buildOrgGraph(
      Option.isSome(registry) ? registry.value.list() : [],
    ),
);
