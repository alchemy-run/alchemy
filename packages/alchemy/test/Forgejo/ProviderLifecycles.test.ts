import {
  BranchProtection,
  Label,
  Organization,
  Team,
  TeamMember,
} from "@/Forgejo/index.ts";
import * as Provider from "@/Provider.ts";
import { destroy } from "@/RemovalPolicy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import {
  json,
  jsonList,
  mockForgejo,
  noContent,
  status,
} from "./support/mock.ts";
import { forgejoTest } from "./support/stack.ts";
import { adopt } from "@/AdoptPolicy.ts";
import { Repository } from "@/Forgejo/index.ts";
import { Services } from "@distilled.cloud/forgejo";
import { fixture, liveTest } from "./support/live.ts";

import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

const live = liveTest();
const raceLive = liveTest((client) =>
  HttpClient.make((request) =>
    Effect.gen(function* () {
      if (request.method === "POST" && request.url.endsWith("/orgs")) {
        yield* client.execute(
          request.pipe(
            HttpClientRequest.bodyJsonUnsafe({
              username: "alchemy-1425-race",
              description: "race winner",
              visibility: "private",
            }),
          ),
        );
      }
      return yield* client.execute(request);
    }),
  ),
);

raceLive.test.provider.skipIf(process.env.FORGEJO_TEST !== "1")(
  "live: organization create-race winner is not implicitly adopted",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { username: owner } = yield* fixture;
      const resource = Organization("Org", {
        owner,
        username: "alchemy-1425-race",
        description: "managed",
        visibility: "limited",
      }).pipe(destroy());
      const rejected = yield* stack.deploy(resource).pipe(Effect.result);
      const before = yield* Services.organization.getOrg({
        org: "alchemy-1425-race",
      });
      yield* stack.deploy(resource.pipe(adopt(true)));
      const after = yield* Services.organization.getOrg({
        org: "alchemy-1425-race",
      });
      yield* stack.destroy();
      expect(Result.isFailure(rejected)).toBe(true);
      expect(JSON.stringify(rejected)).toContain("OwnedBySomeoneElse");
      expect(before.description).toBe("race winner");
      expect(before.visibility).toBe("private");
      expect(after.description).toBe("managed");
      expect(after.visibility).toBe("limited");
    }),
  { timeout: 90_000 },
);
live.test.provider.skipIf(process.env.FORGEJO_TEST !== "1")(
  "live: organization preserves omitted strings and rejects unapplied public visibility",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { username: owner } = yield* fixture;
      const username = "alchemy-1425-org-visibility";
      yield* stack.deploy(
        Organization("Org", {
          owner,
          username,
          visibility: "private",
          description: "keep",
          fullName: "Keep",
          website: "https://example.invalid",
          location: "Earth",
        }).pipe(destroy()),
      );
      yield* stack.deploy(
        Organization("Org", { owner, username, visibility: "limited" }).pipe(
          destroy(),
        ),
      );
      const preserved = yield* Services.organization.getOrg({ org: username });
      const rejected = yield* stack
        .deploy(
          Organization("Org", { owner, username, visibility: "public" }).pipe(
            destroy(),
          ),
        )
        .pipe(Effect.result);
      yield* stack.destroy();
      expect(preserved.description).toBe("keep");
      expect(preserved.full_name).toBe("Keep");
      expect(preserved.location).toBe("Earth");
      expect(JSON.stringify(rejected)).toContain(
        "OrganizationSettingsNotApplied",
      );
    }),
  { timeout: 90_000 },
);

live.test.provider.skipIf(process.env.FORGEJO_TEST !== "1")(
  "live: team defaults and standalone all-repositories update",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { username: owner } = yield* fixture;
      const deploy = (includesAllRepositories?: boolean) =>
        Effect.gen(function* () {
          const org = yield* Organization("Org", {
            owner,
            username: "alchemy-1425-team",
          }).pipe(destroy());
          return yield* Team("Team", {
            organization: org.username,
            name: "Readers",
            includesAllRepositories,
          });
        });
      const first = yield* stack.deploy(deploy());
      const observed = yield* Services.organization.orgGetTeam({
        id: first.teamId,
      });
      expect(observed.permission).toBe("read");
      expect(observed.units).toEqual(["repo.code"]);
      yield* stack.deploy(deploy(true));
      expect(
        (yield* Services.organization.orgGetTeam({ id: first.teamId }))
          .includes_all_repositories,
      ).toBe(true);
      yield* stack.deploy(deploy(false));
      expect(
        (yield* Services.organization.orgGetTeam({ id: first.teamId }))
          .includes_all_repositories,
      ).toBe(false);
      yield* stack.destroy();
      expect(
        yield* Services.organization
          .orgGetTeam({ id: first.teamId })
          .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined))),
      ).toBeUndefined();
    }),
  { timeout: 90_000 },
);

live.test.provider.skipIf(process.env.FORGEJO_TEST !== "1")(
  "live: team flag updates preserve mixed unit permissions",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { username: owner } = yield* fixture;
      const program = (
        includesAllRepositories?: boolean,
        permission?: "read" | "write",
        units?: string[],
      ) =>
        Effect.gen(function* () {
          const org = yield* Organization("Org", {
            owner,
            username: "alchemy-1425-team-units",
          }).pipe(destroy());
          return yield* Team("Team", {
            organization: org.username,
            name: "Mixed",
            includesAllRepositories,
            permission,
            units,
          });
        });
      const first = yield* stack.deploy(program());
      const units_map = { "repo.code": "read", "repo.issues": "write" };
      yield* Services.organization.orgEditTeam({
        id: first.teamId,
        name: "Mixed",
        permission: "read",
        units_map,
      });
      yield* stack.deploy(program(true));
      const preserved = yield* Services.organization.orgGetTeam({
        id: first.teamId,
      });
      yield* stack.deploy(program(false, "write", ["repo.issues"]));
      const changed = yield* Services.organization.orgGetTeam({
        id: first.teamId,
      });
      yield* stack.destroy();
      expect(preserved.units_map).toEqual(units_map);
      expect(preserved.includes_all_repositories).toBe(true);
      expect(changed.permission).toBe("write");
      expect(changed.units).toEqual(["repo.issues"]);
      expect(changed.includes_all_repositories).toBe(false);
    }),
  { timeout: 90_000 },
);

live.test.provider.skipIf(process.env.FORGEJO_TEST !== "1")(
  "live: label edits preserve unmanaged archive state",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { username: owner } = yield* fixture;
      const deploy = (color: string, isArchived?: boolean) =>
        Effect.gen(function* () {
          const repo = yield* Repository("Repo", {
            owner,
            name: "alchemy-1425-label",
          }).pipe(destroy());
          return yield* Label("Label", {
            owner,
            repository: repo.name,
            name: "old",
            color,
            isArchived,
          });
        });
      const first = yield* stack.deploy(deploy("aabbcc", true));
      yield* stack.deploy(deploy("ddeeff"));
      const archived = yield* Services.issue.issueGetLabel({
        owner,
        repo: "alchemy-1425-label",
        id: first.labelId,
      });
      yield* stack.deploy(deploy("ddeeff", false));
      const unarchived = yield* Services.issue.issueGetLabel({
        owner,
        repo: "alchemy-1425-label",
        id: first.labelId,
      });
      yield* stack.destroy();
      expect(archived.is_archived).toBe(true);
      expect(unarchived.is_archived).toBe(false);
    }),
  { timeout: 90_000 },
);

live.test.provider.skipIf(process.env.FORGEJO_TEST !== "1")(
  "live: explicit whitelist toggles preserve observed push permission",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { username: owner } = yield* fixture;
      const deploy = (enablePushWhitelist: boolean, enablePush?: boolean) =>
        Effect.gen(function* () {
          const repo = yield* Repository("Repo", {
            owner,
            name: "alchemy-1425-branch",
            autoInit: true,
          }).pipe(destroy());
          return yield* BranchProtection("Rule", {
            owner,
            repository: repo.name,
            ruleName: "main",
            enablePush,
            enablePushWhitelist,
          });
        });
      yield* stack.deploy(deploy(false, true));
      yield* Services.repository.repoEditBranchProtection({
        owner,
        repo: "alchemy-1425-branch",
        name: "main",
        enable_push: true,
        push_whitelist_usernames: [owner],
      });
      yield* stack.deploy(deploy(true));
      const enabled = yield* Services.repository.repoGetBranchProtection({
        owner,
        repo: "alchemy-1425-branch",
        name: "main",
      });
      yield* stack.deploy(deploy(false));
      const disabled = yield* Services.repository.repoGetBranchProtection({
        owner,
        repo: "alchemy-1425-branch",
        name: "main",
      });
      const contradictory = yield* stack
        .deploy(deploy(true, false))
        .pipe(Effect.result);
      yield* stack.destroy();
      expect(JSON.stringify(contradictory)).toContain(
        "InvalidBranchProtection",
      );
      expect(enabled.enable_push).toBe(true);
      expect(enabled.enable_push_whitelist).toBe(true);
      expect(disabled.enable_push).toBe(true);
      expect(disabled.enable_push_whitelist).toBe(false);
      expect(enabled.push_whitelist_usernames).toEqual([owner]);
      expect(disabled.push_whitelist_usernames).toEqual([owner]);
    }),
  { timeout: 90_000 },
);

for (const kind of ["team", "membership", "label", "branch rule"] as const) {
  live.test.provider.skipIf(process.env.FORGEJO_TEST !== "1")(
    `live: foreign ${kind} requires explicit adoption`,
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const { username: owner } = yield* fixture;
        const suffix = kind.replaceAll(" ", "-");
        const orgName = `alchemy-1425-adopt-${suffix}`;
        const repoName = `alchemy-1425-adopt-${suffix}`;
        const program = (include: boolean, consent = false) =>
          Effect.gen(function* () {
            const org = yield* Organization("Org", {
              owner,
              username: orgName,
            }).pipe(destroy());
            const repo = yield* Repository("Repo", {
              owner,
              name: repoName,
              autoInit: true,
            }).pipe(destroy());
            const parentTeam = yield* Team("ParentTeam", {
              organization: org.username,
              name: "Parent",
            });
            if (include) {
              const child: Effect.Effect<
                unknown,
                never,
                import("@/Forgejo/index.ts").Providers
              > =
                kind === "team"
                  ? Team("Foreign", {
                      organization: org.username,
                      name: "Foreign",
                      description: "managed",
                    })
                  : kind === "membership"
                    ? TeamMember("Foreign", {
                        teamId: parentTeam.teamId,
                        username: owner,
                      })
                    : kind === "label"
                      ? Label("Foreign", {
                          owner,
                          repository: repo.name,
                          name: "foreign",
                          color: "ddeeff",
                        })
                      : BranchProtection("Foreign", {
                          owner,
                          repository: repo.name,
                          ruleName: "main",
                          requiredApprovals: 2,
                        });
              yield* child.pipe(adopt(consent));
            }
            return { teamId: parentTeam.teamId };
          });
        const parent = yield* stack.deploy(program(false));
        if (kind === "team")
          yield* Services.organization.orgCreateTeam({
            org: orgName,
            name: "Foreign",
            description: "foreign",
            permission: "read",
            units: ["repo.code"],
          });
        else if (kind === "membership")
          yield* Services.organization.orgAddTeamMember({
            id: parent.teamId,
            username: owner,
          });
        else if (kind === "label")
          yield* Services.issue.issueCreateLabel({
            owner,
            repo: repoName,
            name: "foreign",
            color: "aabbcc",
          });
        else
          yield* Services.repository.repoCreateBranchProtection({
            owner,
            repo: repoName,
            rule_name: "main",
            required_approvals: 1,
          });
        const refused = yield* stack.deploy(program(true)).pipe(Effect.result);
        yield* stack.deploy(program(true, true));
        if (kind === "team")
          expect(
            (yield* Services.organization.orgListTeams({ org: orgName })).find(
              (t) => t.name === "Foreign",
            )?.description,
          ).toBe("managed");
        else if (kind === "label")
          expect(
            (yield* Services.issue.issueListLabels({
              owner,
              repo: repoName,
            })).find((l) => l.name === "foreign")?.color,
          ).toBe("ddeeff");
        else if (kind === "branch rule")
          expect(
            (yield* Services.repository.repoGetBranchProtection({
              owner,
              repo: repoName,
              name: "main",
            })).required_approvals,
          ).toBe(2);
        yield* stack.destroy();
        expect(Result.isFailure(refused)).toBe(true);
        expect(JSON.stringify(refused)).toContain("OwnedBySomeoneElse");
      }),
    { timeout: 90_000 },
  );
}

for (const kind of ["organization", "team", "label"] as const) {
  live.test.provider.skipIf(process.env.FORGEJO_TEST !== "1")(
    `live: missing ${kind} ID cannot claim a reused name`,
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const { username: owner } = yield* fixture;
        const name = `alchemy-1425-missing-${kind}`;
        const program = (updated = false, cleanup = false) =>
          Effect.gen(function* () {
            const org = yield* Organization(
              kind === "organization" && cleanup ? "ForeignOrg" : "Org",
              {
                owner,
                username: name,
                description: updated ? "updated" : "original",
              },
            ).pipe(destroy(), adopt(kind === "organization" && cleanup));
            const repo = yield* Repository("Repo", { owner, name }).pipe(
              destroy(),
            );
            if (kind === "team") {
              const team = yield* Team(cleanup ? "Foreign" : "Child", {
                organization: org.username,
                name: "Child",
                description: updated ? "updated" : "original",
              }).pipe(adopt(cleanup));
              return { id: team.teamId };
            }
            if (kind === "label") {
              const label = yield* Label(cleanup ? "Foreign" : "Child", {
                owner,
                repository: repo.name,
                name: "Child",
                color: updated ? "ddeeff" : "aabbcc",
              }).pipe(adopt(cleanup));
              return { id: label.labelId };
            }
            return { id: org.organizationId };
          });
        const first = yield* stack.deploy(program());
        let foreignId: number;
        if (kind === "organization") {
          yield* Services.organization.deleteOrg({ org: name });
          foreignId = (yield* Services.admin.adminCreateOrg({
            owner,
            username: name,
            description: "foreign",
          })).id;
        } else if (kind === "team") {
          yield* Services.organization.orgDeleteTeam({ id: first.id });
          foreignId = (yield* Services.organization.orgCreateTeam({
            org: name,
            name: "Child",
            description: "foreign",
            permission: "read",
            units: ["repo.code"],
          })).id;
        } else {
          yield* Services.issue.issueDeleteLabel({
            owner,
            repo: name,
            id: first.id,
          });
          foreignId = (yield* Services.issue.issueCreateLabel({
            owner,
            repo: name,
            name: "Child",
            color: "112233",
          })).id;
        }
        const refused = yield* stack.deploy(program(true)).pipe(Effect.result);
        const adopted = yield* stack.deploy(program(false, true));
        yield* stack.destroy();
        expect(Result.isFailure(refused)).toBe(true);
        expect(adopted.id).toBe(foreignId);
        expect(foreignId).not.toBe(first.id);
      }),
    { timeout: 90_000 },
  );
}

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
  /** `"owner"` marks the team Forgejo creates with every organization. */
  permission?: string;
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
/** Simulates a credential that is not an instance administrator. */
let forbidAdminOrgs = false;
/** Simulates repositories the organization still owns on its first deletes. */
let organizationDeletesBlocked = 0;

const reset = () => {
  organizations.clear();
  teams.clear();
  members.clear();
  labels.clear();
  rules.clear();
  nextId = 1;
  forbidAdminOrgs = false;
  organizationDeletesBlocked = 0;
  server.reset();
};

const teamPayload = (team: StoredTeam) => ({
  id: team.id,
  name: team.name,
  description: team.description,
  permission: team.permission,
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
    if (forbidAdminOrgs) return status(403, "must be an administrator");
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
      if (organizationDeletesBlocked > 0) {
        organizationDeletesBlocked -= 1;
        // Verbatim shape of the failure Forgejo 16.0.3 returns while the
        // organization still owns repositories: a 500, not a conflict status.
        return status(
          500,
          '{"message":"user still has ownership of repositories [uid: 16]"}',
        );
      }
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

const { test } = forgejoTest(server);

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

test.provider(
  "surfaces a non-admin credential rather than reporting the org missing",
  (stack) =>
    Effect.gen(function* () {
      reset();
      // Forgejo answers a non-administrator with the same 403 it uses for a
      // duplicate, so the create-race recovery must not swallow it: with no
      // organization to fall back to, the permissions error has to survive.
      forbidAdminOrgs = true;

      const result = yield* Effect.result(
        stack.deploy(
          Organization("Acme", { owner: "alice", username: "acme" }),
        ),
      );

      forbidAdminOrgs = false;
      expect(Result.isFailure(result)).toBe(true);
      expect(JSON.stringify(result)).toContain("Forbidden");
    }),
);

test.provider("refuses to transfer an organization to another owner", (stack) =>
  Effect.gen(function* () {
    reset();

    const created = yield* stack.deploy(
      Organization("Acme", { owner: "alice", username: "acme" }).pipe(
        destroy(),
      ),
    );
    server.reset();

    // An organization's login is globally unique, so the "new" organization a
    // replacement would create is the one that already exists. Left as a
    // replacement, the deploy adopts it back and reports success for an
    // ownership transfer Forgejo has no way to perform — and with removal
    // opted in, the old generation's delete then takes out the organization
    // the new state points at.
    const result = yield* Effect.result(
      stack.deploy(
        Organization("Acme", { owner: "bob", username: "acme" }).pipe(
          destroy(),
        ),
      ),
    );

    expect(Result.isFailure(result)).toBe(true);
    expect(JSON.stringify(result)).toContain("UnsupportedOwnerChange");
    // The organization is untouched: not deleted, not re-created.
    expect(organizations.get("acme")?.id).toBe(created.organizationId);
    expect(server.count("DELETE", "/orgs/acme")).toBe(0);
    expect(server.count("POST", "/admin/users/bob/orgs")).toBe(0);
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

    const resource = Organization("Acme", { owner: "alice", username: "acme" });
    expect(
      Result.isFailure(yield* stack.deploy(resource).pipe(Effect.result)),
    ).toBe(true);
    const output = yield* stack.deploy(resource.pipe(adopt(true)));

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

test.provider(
  "retries an organization delete while it still owns repositories",
  (stack) =>
    Effect.gen(function* () {
      reset();

      yield* stack.deploy(
        Organization("Acme", { owner: "alice", username: "acme" }).pipe(
          destroy(),
        ),
      );
      server.reset();

      // The engine deletes independent resources concurrently, so an
      // organization races the repositories it owns. Failing out on the first
      // rejection makes destroy succeed only on a re-run.
      organizationDeletesBlocked = 2;
      yield* stack.destroy();

      expect(server.count("DELETE", "/orgs/acme")).toBe(3);
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

    const resource = Team("Reviewers", {
      organization: "acme",
      name: "reviewers",
    });
    expect(
      Result.isFailure(yield* stack.deploy(resource).pipe(Effect.result)),
    ).toBe(true);
    const output = yield* stack.deploy(resource.pipe(adopt(true)));

    // Observing by name is what keeps a re-run after a lost state write from
    // creating a duplicate team.
    expect(output).toMatchObject({ teamId: 7 });
    expect(server.count("POST", "/orgs/acme/teams")).toBe(0);
    // The adopted team already matches what was declared, so adoption issues
    // no write at all.
    expect(server.count("PATCH", "/teams/7")).toBe(0);
  }),
);

/**
 * Enumeration feeds `alchemy unsafe nuke` straight into `delete`, and the
 * `Owners` team Forgejo creates with every organization is both something
 * Alchemy never provisioned and what grants the organization its
 * administrators. Leaving it in a listing points teardown at an object that
 * either refuses to be deleted — failing every pass, so a nuke never reports
 * clean — or takes the organization's admin access with it.
 */
test.provider("omits the built-in Owners team from enumeration", () =>
  Effect.gen(function* () {
    reset();
    organizations.set("acme", {
      id: 1,
      username: "acme",
      html_url: "https://forge.example/acme",
    });
    teams.set(1, {
      id: 1,
      organization: "acme",
      name: "Owners",
      permission: "owner",
    });
    teams.set(2, {
      id: 2,
      organization: "acme",
      name: "reviewers",
      permission: "write",
    });
    members.add("1:admin");
    members.add("2:bob");

    const teamProvider = yield* Provider.findProvider(Team);
    expect(yield* teamProvider.list()).toEqual([
      { teamId: 2, name: "reviewers" },
    ]);

    // The Owners team's members are the organization's administrators, so
    // skipping the team has to skip its roster too.
    const memberProvider = yield* Provider.findProvider(TeamMember);
    expect(yield* memberProvider.list()).toEqual([
      { teamId: 2, username: "bob" },
    ]);
  }),
);

/**
 * Adoption is deliberately *not* filtered: a resource that names the Owners
 * team explicitly takes it over rather than trying to create a second team
 * under a name Forgejo has already taken.
 */
test.provider("still adopts the Owners team when named explicitly", (stack) =>
  Effect.gen(function* () {
    reset();
    teams.set(4, {
      id: 4,
      organization: "acme",
      name: "Owners",
      permission: "owner",
    });

    const resource = Team("Owners", { organization: "acme", name: "Owners" });
    expect(
      Result.isFailure(yield* stack.deploy(resource).pipe(Effect.result)),
    ).toBe(true);
    const output = yield* stack.deploy(resource.pipe(adopt(true)));

    expect(output).toMatchObject({ teamId: 4 });
    expect(server.count("POST", "/orgs/acme/teams")).toBe(0);
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

    const resource = Label("Bug", {
      owner: "alice",
      repository: "alchemy",
      name: "bug",
      color: "0000ff",
    });
    expect(
      Result.isFailure(yield* stack.deploy(resource).pipe(Effect.result)),
    ).toBe(true);
    const output = yield* stack.deploy(resource.pipe(adopt(true)));

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

test.provider(
  "enables push enforcement when a whitelist is declared",
  (stack) =>
    Effect.gen(function* () {
      reset();

      yield* stack.deploy(
        BranchProtection("Main", {
          owner: "alice",
          repository: "alchemy",
          ruleName: "main",
          pushWhitelistUsernames: ["release-bot"],
        }),
      );

      // A whitelist Forgejo is not enforcing silently permits everyone.
      expect(
        server.find("POST", "/repos/alice/alchemy/branch_protections")?.body,
      ).toMatchObject({
        push_whitelist_usernames: ["release-bot"],
        enable_push: true,
        enable_push_whitelist: true,
      });
    }),
);

test.provider("leaves the push flags alone when none are declared", (stack) =>
  Effect.gen(function* () {
    reset();

    yield* stack.deploy(
      BranchProtection("Main", {
        owner: "alice",
        repository: "alchemy",
        ruleName: "main",
      }),
    );

    // Omitted props stay unmanaged, so neither flag may reach the wire at
    // all. Asserted as absence rather than a falsy value: `toMatchObject`
    // ignores extra keys, so emitting `enable_push_whitelist: false` here
    // would start managing a setting nobody declared and still pass every
    // other test in this file.
    const body = server.find(
      "POST",
      "/repos/alice/alchemy/branch_protections",
    )?.body;
    // Pins the rule down first — absence assertions hold vacuously on the
    // `undefined` an unsent create would leave behind.
    expect(body).toMatchObject({ rule_name: "main" });
    expect(body).not.toHaveProperty("enable_push");
    expect(body).not.toHaveProperty("enable_push_whitelist");
  }),
);

test.provider(
  "records a push whitelist as unenforced when direct pushes are off",
  (stack) =>
    Effect.gen(function* () {
      reset();

      yield* stack.deploy(
        BranchProtection("Main", {
          owner: "alice",
          repository: "alchemy",
          ruleName: "main",
          pushWhitelistUsernames: ["release-bot"],
          enablePush: false,
        }),
      );

      // Forgejo stores `enable_push_whitelist: false` whenever `enable_push`
      // is false. Asking for a `true` it will not keep leaves a desired state
      // the instance cannot hold, so every later deploy would observe drift
      // and re-issue the same edit forever.
      expect(
        server.find("POST", "/repos/alice/alchemy/branch_protections")?.body,
      ).toMatchObject({
        push_whitelist_usernames: ["release-bot"],
        enable_push: false,
        enable_push_whitelist: false,
      });
    }),
);
