const SkillTypeId = "~alchemy/AI/Skill" as const;

/** What a skill is: a name and description the model sees, and what loading it gives. */
export interface SkillSpec<Tools extends ReadonlyArray<unknown> = ReadonlyArray<unknown>> {
  /** Shown to the model so it can decide when the skill applies. */
  readonly description: string;
  /** What the model reads when it loads the skill. */
  readonly instructions: string;
  /**
   * Files the skill brings (scripts, references), written into the
   * conversation's sandbox under `.skills/<name>/` when it is loaded.
   */
  readonly files?: Readonly<Record<string, string>>;
  /** Tools enabled wherever the skill is selected. They are the harness's own tools. */
  readonly tools?: Tools;
}

export interface SkillClass<
  Name extends string,
  Tools extends ReadonlyArray<unknown> = ReadonlyArray<unknown>,
> {
  readonly [SkillTypeId]: true;
  readonly skillName: Name;
  readonly skill: SkillSpec<Tools>;
}

export type AnySkill = SkillClass<string, ReadonlyArray<any>>;

export const isSkill = (u: unknown): u is AnySkill =>
  (typeof u === "object" || typeof u === "function") && u !== null && SkillTypeId in u;

/**
 * Declare a skill, after the Agent Skills idea: the model sees its name and
 * description and loads its instructions (and files) only when the task
 * calls for it. The same declaration runs on any harness.
 *
 * **Example:** A skill with a script
 * ```typescript
 * export class Releasing extends AI.Skill<Releasing>()("releasing", {
 *   description: "Cut and upload a release. Use when the user asks to ship.",
 *   instructions: "Run the tests, run .skills/releasing/bump.sh, build, then call deploy.",
 *   files: { "bump.sh": "npm version patch --no-git-tag-version\n" },
 * }) {}
 * ```
 */
export const Skill =
  <_Self>() =>
  <const Name extends string, const Tools extends ReadonlyArray<unknown> = readonly []>(
    name: Name,
    skill: SkillSpec<Tools>,
  ): SkillClass<Name, Tools> & (new () => object) =>
    class {
      static readonly [SkillTypeId] = true;
      static readonly skillName = name;
      static readonly skill = skill;
    } as unknown as SkillClass<Name, Tools> & (new () => object);
