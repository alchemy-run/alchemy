import type { AnySkill } from "@alchemy.run/ai/Skill";
import { isSkill as isAiSkill } from "@alchemy.run/ai/Skill";
import type { AnyExtension } from "./Extension.ts";
import type { AnyTool } from "./Tool.ts";

const ExtensionTypeId = "~alchemy/Pi/Extension" as const;

/**
 * An `AI.Skill` as Pi runs it: an extension whose prompt section
 * advertises the skill, loaded with `load_skill` when the task calls for it.
 */
export interface SkillExtension extends AnyExtension {
  readonly [ExtensionTypeId]: "skill";
  readonly skillName: string;
  readonly skill: AnySkill["skill"];
}

export const isSkill = (u: AnyExtension): u is SkillExtension => u[ExtensionTypeId] === "skill";

/** A harness takes extensions and skills in one list; this is each as an extension. */
export const toExtension = (listed: AnyExtension | AnySkill): AnyExtension => {
  if (!isAiSkill(listed)) return listed;
  const { skillName: name, skill } = listed;
  return {
    [ExtensionTypeId]: "skill",
    key: `Pi.Skill/${name}`,
    extensionName: `skill:${name}`,
    skillName: name,
    skill,
    spec: {
      sections: {
        // Pi's section keys allow only [a-z0-9_-].
        [`skill-${name}`]: `<skill name="${name}">${skill.description} Load it with load_skill before you start.</skill>`,
      },
      ...(skill.tools ? { tools: skill.tools as ReadonlyArray<AnyTool> } : {}),
    },
    impl: undefined,
    hasImpl: false,
  } as SkillExtension;
};
