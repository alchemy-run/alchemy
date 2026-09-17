/**
 * `GET /api/org` — the org graph the mirror UI renders: the same
 * structure the code declares (src/Org.ts), served by the deployed
 * Worker from its own Layer builds.
 */

/** One capability a node can reach: the binding (`Cloudflare.R2.
 *  BucketReadWrite`), its target resources (`Cloudflare.R2.Bucket(jobs)`),
 *  and the chain of services it was reached through (empty when the
 *  node acquired it directly). */
export interface OrgPermission {
  readonly binding: string;
  readonly targets: ReadonlyArray<string>;
  readonly via: ReadonlyArray<string>;
}

export interface OrgTool {
  readonly name: string;
  readonly description: string;
  readonly kind: "static" | "class";
  readonly params: ReadonlyArray<string>;
  readonly outputs: ReadonlyArray<string>;
  readonly errors: ReadonlyArray<string>;
  readonly permissions: ReadonlyArray<OrgPermission>;
}

export interface OrgSkillGrant {
  readonly name: string;
  readonly enabled: boolean;
}

export interface OrgAgent {
  readonly name: string;
  readonly slug: string;
  readonly source: string | undefined;
  /** The model the turn hook pins — absent when the charter declares
   *  no `AI.selectModel`. */
  readonly model: { readonly id: string; readonly label: string } | undefined;
  readonly charter: string;
  readonly tools: ReadonlyArray<OrgTool>;
  readonly skills: ReadonlyArray<OrgSkillGrant>;
  readonly groups: ReadonlyArray<string>;
  /** Everything the agent can reach — its charter's, its tools' and
   *  its skills' permissions, merged. */
  readonly permissions: ReadonlyArray<OrgPermission>;
}

export interface OrgSkill {
  readonly name: string;
  readonly source: string | undefined;
  readonly teaching: string;
  readonly tools: ReadonlyArray<string>;
  readonly permissions: ReadonlyArray<OrgPermission>;
}

/** A service key's short name — the last path segment
 *  (`root/JobService` → `JobService`, `alchemy/AI/Tool/bash` → `bash`). */
export const shortKey = (key: string): string =>
  key.slice(key.lastIndexOf("/") + 1);

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

let cached: Promise<OrgGraph> | undefined;

/** The graph, fetched once per page load — every surface that draws
 *  splice pills (chat, profiles) shares the one request. */
export const fetchOrg = (): Promise<OrgGraph> => {
  cached ??= fetch("/api/org").then(
    (response) => response.json() as Promise<OrgGraph>,
  );
  return cached;
};

/** Refetch on the next call — after a skill switch flips. */
export const invalidateOrg = (): void => {
  cached = undefined;
};

/** The agent to open for a TOOL pill: the profile being viewed if it
 *  holds the tool, else the first agent that does. */
export const toolOwner = (
  org: OrgGraph,
  tool: string,
  preferred?: string,
): OrgAgent | undefined => {
  const holds = (agent: OrgAgent) =>
    agent.tools.some((candidate) => candidate.name === tool);
  const current = org.agents.find(
    (agent) => agent.name === preferred && holds(agent),
  );
  return current ?? org.agents.find(holds);
};

/** The agent to open for a SKILL pill — same preference rule. */
export const skillOwner = (
  org: OrgGraph,
  skill: string,
  preferred?: string,
): OrgAgent | undefined => {
  const granted = (agent: OrgAgent) =>
    agent.skills.some((grant) => grant.name === skill);
  const current = org.agents.find(
    (agent) => agent.name === preferred && granted(agent),
  );
  return current ?? org.agents.find(granted);
};

/** One tool's projection, wherever it is granted. */
export const findTool = (org: OrgGraph, name: string): OrgTool | undefined => {
  for (const agent of org.agents) {
    const found = agent.tools.find((tool) => tool.name === name);
    if (found !== undefined) return found;
  }
  return undefined;
};

/** Flip one agent's skill switch. */
export const setAgentSkill = (
  agent: string,
  skill: string,
  enabled: boolean,
): Promise<Response> =>
  fetch(
    `/api/org/agents/${encodeURIComponent(agent)}/skills/${encodeURIComponent(skill)}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled }),
    },
  );
