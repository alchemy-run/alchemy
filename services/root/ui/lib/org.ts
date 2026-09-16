/**
 * `GET /api/org` — the org graph the mirror UI renders: the same
 * structure the code declares (src/Org.ts), served by the deployed
 * Worker from its own Layer builds.
 */

export interface OrgPermission {
  readonly binding: string;
  readonly targets: ReadonlyArray<string>;
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
  readonly model: { readonly id: string; readonly label: string };
  readonly charter: string;
  readonly tools: ReadonlyArray<OrgTool>;
  readonly skills: ReadonlyArray<OrgSkillGrant>;
  readonly groups: ReadonlyArray<string>;
}

export interface OrgSkill {
  readonly name: string;
  readonly source: string | undefined;
  readonly teaching: string;
  readonly tools: ReadonlyArray<string>;
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

export const fetchOrg = (): Promise<OrgGraph> =>
  fetch("/api/org").then((response) => response.json() as Promise<OrgGraph>);

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
