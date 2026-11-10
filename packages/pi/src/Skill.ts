import type { AnyExtension } from "./Extension.ts";
import type { AnyTool } from "./Tool.ts";

const ExtensionTypeId = "~alchemy/Pi/Extension" as const;

/** What a skill is: a name and description the model sees, and what loading it gives. */
export interface SkillSpec {
  /** Shown to the model so it can decide when the skill applies. */
  readonly description: string;
  /** What the model reads when it loads the skill. */
  readonly instructions: string;
  /**
   * Files the skill brings (scripts, references), written into the
   * conversation's environment under `.skills/<name>/` when it is loaded.
   */
  readonly files?: Readonly<Record<string, string>>;
  /** Tools enabled wherever the skill is selected. */
  readonly tools?: ReadonlyArray<AnyTool>;
}

export interface SkillClass<Name extends string> extends AnyExtension {
  readonly [ExtensionTypeId]: "skill";
  readonly extensionName: `skill:${Name}`;
  readonly skillName: Name;
  readonly skill: SkillSpec;
}

export type AnySkill = SkillClass<string>;

export const isSkill = (u: AnyExtension): u is AnySkill => u[ExtensionTypeId] === "skill";

/**
 * Declare a skill, after the Agent Skills idea: the model sees its name and
 * description in the system prompt and loads its instructions (and
 * files) with `load_skill` only when the task calls for it. A skill is an
 * extension, so a conversation selects it like one:
 * `conversation.configure({ extensions: { add: [Releasing] } })`.
 *
 * **Example:** A skill with a script
 * ```typescript
 * export class Releasing extends Pi.Skill<Releasing>()("releasing", {
 *   description: "Cut and upload a release. Use when the user asks to ship.",
 *   instructions: "Run the tests, run .skills/releasing/bump.sh, build, then call deploy.",
 *   files: { "bump.sh": "npm version patch --no-git-tag-version\n" },
 *   tools: [Deploy],
 * }) {}
 * ```
 */
export const Skill =
  <_Self>() =>
  <const Name extends string>(
    name: Name,
    skill: SkillSpec,
  ): SkillClass<Name> & (new () => object) =>
    class {
      static readonly [ExtensionTypeId] = "skill";
      static readonly key = `Pi.Skill/${name}`;
      static readonly extensionName = `skill:${name}`;
      static readonly skillName = name;
      static readonly skill = skill;
      static readonly spec = {
        sections: {
          [`skill:${name}`]: `<skill name="${name}">${skill.description} Load it with load_skill before you start.</skill>`,
        },
        ...(skill.tools ? { tools: skill.tools } : {}),
      };
      static readonly impl = undefined;
      static readonly hasImpl = false;
    } as unknown as SkillClass<Name> & (new () => object);
