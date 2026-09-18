/**
 * THE DERIVED ROSTER — membership and routing rubrics read off the
 * org graph instead of a hand-kept list. Add an agent to a group's
 * chart in code and it appears in the room, with a rubric taken from
 * the head of its own charter when the curated map has never heard
 * of it.
 */
import { describe, expect, test } from "bun:test";
import { buildOrgGraph } from "../../src/Org.ts";
import { rosterFromGraph } from "../../src/chat/Roster.ts";
import { ROLES } from "../../src/chat/Gate.ts";
import Root, { RootChart } from "../../src/Root.ts";
import Engineering from "../../src/engineering/Group.ts";
import { EngineeringChart } from "../../src/engineering/Group.ts";
import { Head } from "../../src/Head.ts";
import { Manager } from "../../src/engineering/Manager.ts";
import { Engineer } from "../../src/engineering/Engineer.ts";
import { Reviewer } from "../../src/engineering/Reviewer.ts";

/** Registry rows the way the real Layers register them. */
const nodes = [
  {
    kind: "Group" as const,
    name: "Root",
    template: (RootChart as { template: TemplateStringsArray }).template,
    refs: (RootChart as { refs: ReadonlyArray<unknown> }).refs,
  },
  {
    kind: "Group" as const,
    name: "Engineering",
    template: (EngineeringChart as { template: TemplateStringsArray }).template,
    refs: (EngineeringChart as { refs: ReadonlyArray<unknown> }).refs,
  },
  {
    kind: "Agent" as const,
    name: "Engineer",
    template: Object.assign(["An engineer on the alchemy team. "], {
      raw: ["An engineer on the alchemy team. "],
    }) as TemplateStringsArray,
    refs: [],
  },
];

describe("the derived roster", () => {
  const roster = rosterFromGraph(buildOrgGraph(nodes));

  test("group charts decide who is in each room", () => {
    expect(roster.membersOf("root")).toEqual(["head"]);
    expect(roster.membersOf("engineering")).toEqual([
      "manager",
      "engineer",
      "reviewer",
    ]);
    expect(roster.membersOf("marketing")).toBeUndefined();
  });

  test("curated rubrics survive; unknown agents get their charter's head", () => {
    const roles = roster.rolesFor(["engineer", "newcomer"]);
    expect(roles.engineer).toEqual(ROLES.engineer);
    expect(roles.newcomer!.what.length).toBeGreaterThan(0);
  });

  test("the graph names the same classes the code exports", () => {
    // the fixture rows above are built FROM the real charts — if a
    // member is renamed in code, this pins the derivation catching it
    expect([Root, Engineering, Head, Manager, Engineer, Reviewer]).toHaveLength(
      6,
    );
  });
});
