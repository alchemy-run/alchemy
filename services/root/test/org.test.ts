/**
 * The org graph's PERMISSIONS — projected from the recorded
 * capability graph onto tools, skills and agents (src/Org.ts).
 *
 * - a ToolDef's rows come from its own frame; a class tool's from the
 *   Layer that provides its tag;
 * - a skill's rows are its frame's plus its class tools';
 * - an agent's rows are its frame's plus every granted tool's and
 *   skill's — one row per (binding, targets), the shortest chain kept.
 */
import * as AI from "alchemy/AI";
import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as S from "effect/Schema";
import { buildOrgGraph, type Permissions } from "../src/Org.ts";

const key = AI.Thing("key", S.String)`The key.`;
const park = AI.Tool("park")`Park ${key}.`(
  Effect.succeed(() => Effect.succeed({})),
);
class Bash extends (AI.Tool<Bash>()("bash")`Run a command.`) {}
class Archives extends AI.Skill<Archives>()("Archives") {}
class Head extends AI.Agent<Head>()("Head") {}

const template = (strings: TemplateStringsArray, ..._values: unknown[]) =>
  strings;

const nodes: AI.OrgNode[] = [
  {
    kind: "Skill",
    name: "Archives",
    template: template`Use ${""}.`,
    refs: [Bash],
  },
  {
    kind: "Agent",
    name: "Head",
    template: template`You lead. ${""} files; ${""} runs; ${""} teaches.`,
    refs: [park, Bash, Archives],
  },
];

const bucket = {
  binding: "Cloudflare.R2.BucketReadWrite",
  targets: ["Cloudflare.R2.Bucket(jobs)"],
};
const sandbox = {
  binding: "Cloudflare.Containers.Exec",
  targets: ["Cloudflare.Containers.Container(sandbox)"],
};
const mail = { binding: "AWS.SES.SendEmail", targets: [] };

const permissions: Permissions = {
  ofFrame: (kind, name) => {
    if (kind === "Tool" && name === "park") {
      return [{ ...bucket, via: ["root/JobService"] }];
    }
    if (kind === "Agent" && name === "Head") {
      // the charter itself reached the bucket, directly
      return [
        { ...bucket, via: [] },
        { ...mail, via: ["root/Mailer"] },
      ];
    }
    return [];
  },
  ofService: (serviceKey) =>
    serviceKey === Bash.key ? [{ ...sandbox, via: [] }] : [],
};

test("tools: a ToolDef from its frame, a class tool from its physics", () => {
  const graph = buildOrgGraph(nodes, new Set(), permissions);
  const head = graph.agents.find((agent) => agent.name === "Head")!;
  expect(head.tools.find((tool) => tool.name === "park")?.permissions).toEqual([
    { ...bucket, via: ["root/JobService"] },
  ]);
  expect(head.tools.find((tool) => tool.name === "bash")?.permissions).toEqual([
    { ...sandbox, via: [] },
  ]);
});

test("skills: the frame's rows plus the class tools' physics", () => {
  const graph = buildOrgGraph(nodes, new Set(), permissions);
  expect(graph.skills[0]?.permissions).toEqual([{ ...sandbox, via: [] }]);
});

test("agents: merged over the charter, tools and skills — shortest chain wins", () => {
  const graph = buildOrgGraph(nodes, new Set(), permissions);
  const head = graph.agents.find((agent) => agent.name === "Head")!;
  expect(head.permissions).toEqual([
    // direct rows first, by binding (the charter's direct bucket row
    // beats the tool's via-chain to the same bucket)
    { ...sandbox, via: [] },
    { ...bucket, via: [] },
    { ...mail, via: ["root/Mailer"] },
  ]);
});

test("no graph: every node reaches nothing", () => {
  const graph = buildOrgGraph(nodes);
  expect(graph.agents[0]?.permissions).toEqual([]);
  expect(graph.skills[0]?.permissions).toEqual([]);
  expect(
    graph.agents[0]?.tools.every((tool) => tool.permissions.length === 0),
  ).toBe(true);
});
