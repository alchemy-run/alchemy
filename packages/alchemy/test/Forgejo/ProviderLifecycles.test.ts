import {
  BranchProtection,
  Label,
  Organization,
  Team,
  TeamMember,
  providers,
} from "@/Forgejo/index.ts";
import { destroy } from "@/RemovalPolicy";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  json,
  jsonList,
  mockForgejo,
  noContent,
  status,
} from "./support/mock.ts";

interface StoredOrganization {
  readonly id: number;
  readonly username: string;
  readonly html_url: string;
  description?: string;
}

interface StoredTeam {
  readonly id: number;
  readonly organization: string;
  name: string;
  description?: string;
}

interface StoredLabel {
  readonly id: number;
  readonly repository: string;
  name: string;
  color: string;
}

interface StoredRule {
  readonly repository: string;
  readonly rule_name: string;
  required_approvals?: number;
}

const organizations = new Map<string, StoredOrganization>();
const teams = new Map<number, StoredTeam>();
const members = new Set<string>();
const labels = new Map<number, StoredLabel>();
const rules = new Map<string, StoredRule>();
let nextId = 1;

const reset = () => {
  organizations.clear();
  teams.clear();
  members.clear();
  labels.clear();
  rules.clear();
  nextId = 1;
  server.reset();
};

const teamPayload = (team: StoredTeam) => ({
  id: team.id,
  name: team.name,
  description: team.description,
});

const labelPayload = (label: StoredLabel) => ({
  id: label.id,
  name: label.name,
  color: label.color,
});

const server = mockForgejo((request) => {
  const { method, path, body } = request;
  const payload = body as Record<string, string | number> | undefined;

  if (method === "GET" && path === "/user/orgs") {
    return jsonList(request, [...organizations.values()]);
  }

  const adminOrgs = path.match(/^\/admin\/users\/([^/]+)\/orgs$/);
  if (method === "POST" && adminOrgs !== null) {
    const username = String(payload?.username);
    const organization: StoredOrganization = {
      id: nextId++,
      username,
      html_url: `https://forge.example/${username}`,
      description: payload?.description as string | undefined,
    };
    organizations.set(username, organization);
    return json(organization, 201);
  }

  const org = path.match(/^\/orgs\/([^/]+)$/);
  if (org !== null) {
    const existing = organizations.get(org[1]!);
    if (method === "GET") {
      return existing === undefined ? status(404) : json(existing);
    }
    if (method === "PATCH") {
      if (existing === undefined) return status(404);
      existing.description = payload?.description as string | undefined;
      return json(existing);
    }
    if (method === "DELETE") {
      organizations.delete(org[1]!);
      return noContent();
    }
  }

  const orgTeams = path.match(/^\/orgs\/([^/]+)\/teams$/);
  if (orgTeams !== null) {
    if (method === "GET") {
      return jsonList(
        request,
        [...teams.values()]
          .filter((team) => team.organization === orgTeams[1])
          .map(teamPayload),
      );
    }
    if (method === "POST") {
      const team: StoredTeam = {
        id: nextId++,
        organization: orgTeams[1]!,
        name: String(payload?.name),
        description: payload?.description as string | undefined,
      };
      teams.set(team.id, team);
      return json(teamPayload(team), 201);
    }
  }

  const teamMember = path.match(/^\/teams\/(\d+)\/members\/([^/]+)$/);
  if (teamMember !== null) {
    const key = `${teamMember[1]}:${teamMember[2]}`;
    if (method === "GET") {
      return members.has(key) ? json({ login: teamMember[2] }) : status(404);
    }
    if (method === "PUT") {
      members.add(key);
      return noContent();
    }
    if (method === "DELETE") {
      members.delete(key);
      return noContent();
    }
  }

  const teamMembers = path.match(/^\/teams\/(\d+)\/members$/);
  if (method === "GET" && teamMembers !== null) {
    return jsonList(
      request,
      [...members]
        .filter((key) => key.startsWith(`${teamMembers[1]}:`))
        .map((key) => ({ login: key.split(":")[1] })),
    );
  }

  const team = path.match(/^\/teams\/(\d+)$/);
  if (team !== null) {
    const existing = teams.get(Number(team[1]));
    if (method === "GET") {
      return existing === undefined ? status(404) : json(teamPayload(existing));
    }
    if (method === "PATCH") {
      if (existing === undefined) return status(404);
      existing.name = String(payload?.name);
      existing.description = payload?.description as string | undefined;
      return json(teamPayload(existing));
    }
    if (method === "DELETE") {
      teams.delete(Number(team[1]));
      return noContent();
    }
  }

  const labelCollection = path.match(/^\/repos\/([^/]+\/[^/]+)\/labels$/);
  if (labelCollection !== null) {
    if (method === "GET") {
      return jsonList(
        request,
        [...labels.values()]
          .filter((label) => label.repository === labelCollection[1])
          .map(labelPayload),
      );
    }
    if (method === "POST") {
      const label: StoredLabel = {
        id: nextId++,
        repository: labelCollection[1]!,
        name: String(payload?.name),
        color: String(payload?.color),
      };
      labels.set(label.id, label);
      return json(labelPayload(label), 201);
    }
  }

  const label = path.match(/^\/repos\/[^/]+\/[^/]+\/labels\/(\d+)$/);
  if (label !== null) {
    const existing = labels.get(Number(label[1]));
    if (method === "GET") {
      return existing === undefined
        ? status(404)
        : json(labelPayload(existing));
    }
    if (method === "PATCH") {
      if (existing === undefined) return status(404);
      existing.name = String(payload?.name);
      existing.color = String(payload?.color);
      return json(labelPayload(existing));
    }
    if (method === "DELETE") {
      labels.delete(Number(label[1]));
      return noContent();
    }
  }

  const ruleCollection = path.match(
    /^\/repos\/([^/]+\/[^/]+)\/branch_protections$/,
  );
  if (ruleCollection !== null) {
    if (method === "GET") {
      return jsonList(
        request,
        [...rules.values()].filter(
          (rule) => rule.repository === ruleCollection[1],
        ),
      );
    }
    if (method === "POST") {
      const rule: StoredRule = {
        repository: ruleCollection[1]!,
        rule_name: String(payload?.rule_name),
        required_approvals: payload?.required_approvals as number | undefined,
      };
      rules.set(`${rule.repository}/${rule.rule_name}`, rule);
      return json(rule, 201);
    }
  }

  const rule = path.match(
    /^\/repos\/([^/]+\/[^/]+)\/branch_protections\/([^/]+)$/,
  );
  if (rule !== null) {
    const key = `${rule[1]}/${rule[2]}`;
    const existing = rules.get(key);
    if (method === "GET") {
      return existing === undefined ? status(404) : json(existing);
    }
    if (method === "PATCH") {
      if (existing === undefined) return status(404);
      existing.required_approvals = payload?.required_approvals as
        | number
        | undefined;
      return json(existing);
    }
    if (method === "DELETE") {
      rules.delete(key);
      return noContent();
    }
  }

  return undefined;
});

const { test } = Test.make({
  providers: providers({
    baseUrl: "https://forge.example",
    token: "admin-token",
  }).pipe(Layer.provide(server.layer)),
});

test.provider("creates and then updates an organization", (stack) =>
  Effect.gen(function* () {
    reset();

    const created = yield* stack.deploy(
      Organization("Acme", {
        owner: "alice",
        username: "acme",
        description: "first",
      }),
    );
    expect(created).toMatchObject({ username: "acme", organizationId: 1 });
    expect(server.find("POST", "/admin/users/alice/orgs")?.body).toMatchObject({
      username: "acme",
      description: "first",
    });

    server.reset();
    yield* stack.deploy(
      Organization("Acme", {
        owner: "alice",
        username: "acme",
        description: "second",
      }),
    );

    // Live state already had the organization, so the second run syncs
    // settings instead of attempting another create.
    expect(server.count("POST", "/admin/users/alice/orgs")).toBe(0);
    expect(server.find("PATCH", "/orgs/acme")?.body).toMatchObject({
      description: "second",
    });
  }),
);

test.provider("adopts an organization that already exists", (stack) =>
  Effect.gen(function* () {
    reset();
    organizations.set("acme", {
      id: 99,
      username: "acme",
      html_url: "https://forge.example/acme",
    });

    const output = yield* stack.deploy(
      Organization("Acme", { owner: "alice", username: "acme" }),
    );

    expect(output).toMatchObject({ organizationId: 99 });
    expect(server.count("POST", "/admin/users/alice/orgs")).toBe(0);
  }),
);

test.provider("retains an organization on destroy by default", (stack) =>
  Effect.gen(function* () {
    reset();

    yield* stack.deploy(
      Organization("Acme", { owner: "alice", username: "acme" }),
    );
    server.reset();
    yield* stack.destroy();

    expect(server.count("DELETE", "/orgs/acme")).toBe(0);
    expect(organizations.has("acme")).toBe(true);
  }),
);

test.provider("deletes an organization when removal is opted in", (stack) =>
  Effect.gen(function* () {
    reset();

    yield* stack.deploy(
      Organization("Acme", { owner: "alice", username: "acme" }).pipe(
        destroy(),
      ),
    );
    server.reset();
    yield* stack.destroy();

    expect(server.count("DELETE", "/orgs/acme")).toBe(1);
    expect(organizations.has("acme")).toBe(false);
  }),
);

test.provider("creates, updates and deletes a team", (stack) =>
  Effect.gen(function* () {
    reset();

    const created = yield* stack.deploy(
      Team("Reviewers", {
        organization: "acme",
        name: "reviewers",
        description: "first",
      }),
    );
    expect(created).toMatchObject({ teamId: 1, name: "reviewers" });
    expect(server.find("POST", "/orgs/acme/teams")?.body).toMatchObject({
      name: "reviewers",
      description: "first",
    });

    server.reset();
    yield* stack.deploy(
      Team("Reviewers", {
        organization: "acme",
        name: "reviewers",
        description: "second",
      }),
    );
    expect(server.count("POST", "/orgs/acme/teams")).toBe(0);
    expect(server.find("PATCH", "/teams/1")?.body).toMatchObject({
      description: "second",
    });

    server.reset();
    yield* stack.destroy();
    expect(server.count("DELETE", "/teams/1")).toBe(1);
    expect(teams.size).toBe(0);
  }),
);

test.provider("adopts a team that already exists by name", (stack) =>
  Effect.gen(function* () {
    reset();
    teams.set(7, { id: 7, organization: "acme", name: "reviewers" });

    const output = yield* stack.deploy(
      Team("Reviewers", { organization: "acme", name: "reviewers" }),
    );

    // Observing by name is what keeps a re-run after a lost state write from
    // creating a duplicate team.
    expect(output).toMatchObject({ teamId: 7 });
    expect(server.count("POST", "/orgs/acme/teams")).toBe(0);
    expect(server.count("PATCH", "/teams/7")).toBe(1);
  }),
);

test.provider("adds and removes a team member", (stack) =>
  Effect.gen(function* () {
    reset();

    const output = yield* stack.deploy(
      TeamMember("Bob", { teamId: 3, username: "bob" }),
    );
    expect(output).toEqual({ teamId: 3, username: "bob" });
    expect(server.count("PUT", "/teams/3/members/bob")).toBe(1);
    expect(members.has("3:bob")).toBe(true);

    server.reset();
    yield* stack.destroy();
    expect(server.count("DELETE", "/teams/3/members/bob")).toBe(1);
    expect(members.has("3:bob")).toBe(false);
  }),
);

test.provider("creates, updates and deletes a label", (stack) =>
  Effect.gen(function* () {
    reset();

    const created = yield* stack.deploy(
      Label("Bug", {
        owner: "alice",
        repository: "alchemy",
        name: "bug",
        color: "ff0000",
      }),
    );
    expect(created).toMatchObject({ labelId: 1, name: "bug", color: "ff0000" });
    expect(
      server.find("POST", "/repos/alice/alchemy/labels")?.body,
    ).toMatchObject({
      name: "bug",
      color: "ff0000",
    });

    server.reset();
    const updated = yield* stack.deploy(
      Label("Bug", {
        owner: "alice",
        repository: "alchemy",
        name: "bug",
        color: "00ff00",
      }),
    );
    expect(updated).toMatchObject({ color: "00ff00" });
    expect(server.count("POST", "/repos/alice/alchemy/labels")).toBe(0);
    expect(server.count("PATCH", "/repos/alice/alchemy/labels/1")).toBe(1);

    server.reset();
    yield* stack.destroy();
    expect(server.count("DELETE", "/repos/alice/alchemy/labels/1")).toBe(1);
    expect(labels.size).toBe(0);
  }),
);

test.provider("adopts a label that already exists by name", (stack) =>
  Effect.gen(function* () {
    reset();
    labels.set(4, {
      id: 4,
      repository: "alice/alchemy",
      name: "bug",
      color: "ff0000",
    });

    const output = yield* stack.deploy(
      Label("Bug", {
        owner: "alice",
        repository: "alchemy",
        name: "bug",
        color: "0000ff",
      }),
    );

    expect(output).toMatchObject({ labelId: 4, color: "0000ff" });
    expect(server.count("POST", "/repos/alice/alchemy/labels")).toBe(0);
  }),
);

test.provider(
  "creates, updates and deletes a branch-protection rule",
  (stack) =>
    Effect.gen(function* () {
      reset();

      const created = yield* stack.deploy(
        BranchProtection("Main", {
          owner: "alice",
          repository: "alchemy",
          ruleName: "main",
          requiredApprovals: 1,
        }),
      );
      expect(created).toEqual({
        owner: "alice",
        repository: "alchemy",
        ruleName: "main",
      });
      expect(
        server.find("POST", "/repos/alice/alchemy/branch_protections")?.body,
      ).toMatchObject({
        rule_name: "main",
        required_approvals: 1,
      });

      server.reset();
      yield* stack.deploy(
        BranchProtection("Main", {
          owner: "alice",
          repository: "alchemy",
          ruleName: "main",
          requiredApprovals: 2,
        }),
      );
      expect(
        server.count("POST", "/repos/alice/alchemy/branch_protections"),
      ).toBe(0);
      expect(
        server.find("PATCH", "/repos/alice/alchemy/branch_protections/main")
          ?.body,
      ).toMatchObject({ required_approvals: 2 });

      server.reset();
      yield* stack.destroy();
      expect(
        server.count("DELETE", "/repos/alice/alchemy/branch_protections/main"),
      ).toBe(1);
      expect(rules.size).toBe(0);
    }),
);
