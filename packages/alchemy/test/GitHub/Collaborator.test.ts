import * as Orgs from "@distilled.cloud/github/orgs";
import * as Repos from "@distilled.cloud/github/repos";
import * as GitHub from "@/GitHub";
import { githubFor } from "@/GitHub/Client.ts";
import * as Output from "@/Output";
import * as Provider from "@/Provider";
import { destroy } from "@/RemovalPolicy";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

const requireTestOwner = (owner: string) => {
  if (owner !== "alchemy-run-test" && owner !== "alchemy-run-test-2") {
    throw new Error(`Refusing GitHub collaborator tests for owner ${owner}`);
  }
  return owner;
};

const owner = requireTestOwner(
  process.env.GITHUB_TEST_OWNER ?? "alchemy-run-test",
);
const fixtureNames = [
  "alchemy-pr-1571-collaborator-lifecycle",
  "alchemy-pr-1571-collaborator-replacement",
  "alchemy-pr-1571-collaborator-list",
];

const { test } = Test.make({
  providers: GitHub.providers({ baseUrl: "github.com" }),
});

const verifiedMember = Effect.gen(function* () {
  const github = yield* githubFor();
  const requested = process.env.GITHUB_TEST_COLLABORATOR_USERNAME;
  if (!requested) {
    const members = yield* Orgs.listMembers
      .items({ org: owner, role: "member", per_page: 100 })
      .pipe(Stream.runCollect, github);
    return yield* Effect.fail(
      new Error(
        `Set GITHUB_TEST_COLLABORATOR_USERNAME to an explicitly authorized active non-owner member of ${owner}; eligible members: ${members.map((member) => member.login).join(", ") || "none"}. No invitations or owner access changes are permitted.`,
      ),
    );
  }
  const membership = yield* Orgs.getMembershipForUser({
    org: owner,
    username: requested,
  }).pipe(github);
  if (membership.state !== "active" || membership.role !== "member") {
    return yield* Effect.fail(
      new Error(
        `Refusing collaborator ${requested}: ${owner} membership is ${membership.state}/${membership.role}; an authorized active non-owner member is required.`,
      ),
    );
  }
  return requested;
});

const repository = (index: number) =>
  GitHub.Repository(`Repo${index}`, {
    owner,
    name: fixtureNames[index]!,
    description:
      "PR 1571 collaborator test fixture; retained because the test token lacks delete_repo",
    visibility: "private",
    autoInit: true,
  });

const directCollaborators = (repo: string) =>
  Effect.gen(function* () {
    const github = yield* githubFor();
    return yield* Repos.listCollaborators
      .items({ owner, repo, affiliation: "direct", per_page: 100 })
      .pipe(Stream.runCollect, github);
  });

const assertRemoved = (repo: string, username: string) =>
  Effect.gen(function* () {
    const remaining = yield* directCollaborators(repo).pipe(
      Effect.repeat({
        until: (collaborators) =>
          !collaborators.some(
            (collaborator) => collaborator.login === username,
          ),
        schedule: Schedule.spaced("1 second"),
        times: 8,
      }),
    );
    expect(
      remaining.some((collaborator) => collaborator.login === username),
    ).toBe(false);
    const github = yield* githubFor();
    const invitations = yield* Repos.listInvitations
      .items({ owner, repo, per_page: 100 })
      .pipe(Stream.runCollect, github);
    expect(
      invitations.some((invitation) => invitation.invitee?.login === username),
    ).toBe(false);
  });

test.provider(
  "add, update, replace, and remove an authorized collaborator",
  (stack) =>
    Effect.gen(function* () {
      // Verify authorization before even replaying persisted deletes.
      const username = yield* verifiedMember;
      yield* stack.destroy();
      const deploy = (
        index: number,
        permission?: GitHub.CollaboratorProps["permission"],
      ) =>
        stack.deploy(
          Effect.gen(function* () {
            // Keep both dependencies present while replacing the collaborator.
            const first = yield* repository(0);
            const second = yield* repository(1);
            return yield* GitHub.Collaborator("Collab", {
              owner,
              repository: Output.map(
                (index === 0 ? first : second).fullName,
                (fullName) => fullName.split("/")[1]!,
              ),
              username,
              permission,
            }).pipe(destroy());
          }),
        );
      const created = yield* deploy(0);
      expect(created.username).toBe(username);
      expect(created.permission).toBe("push");
      expect(
        (yield* directCollaborators(fixtureNames[0]!)).find(
          (member) => member.login === username,
        )?.permissions?.push,
      ).toBe(true);

      const updated = yield* deploy(0, "admin");
      expect(updated.permission).toBe("admin");
      expect(
        (yield* directCollaborators(fixtureNames[0]!)).find(
          (member) => member.login === username,
        )?.permissions?.admin,
      ).toBe(true);

      const replaced = yield* deploy(1, "triage");
      expect(replaced.permission).toBe("triage");
      yield* assertRemoved(fixtureNames[0]!, username);
      expect(
        (yield* directCollaborators(fixtureNames[1]!)).some(
          (member) => member.login === username,
        ),
      ).toBe(true);

      // Remove access independently while both retained repositories still exist.
      yield* stack.deploy(
        Effect.gen(function* () {
          yield* repository(0);
          yield* repository(1);
        }),
      );
      yield* assertRemoved(fixtureNames[1]!, username);
      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);

test.provider(
  "list enumerates the dedicated test repository's collaborators",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      yield* stack.deploy(repository(2));
      const github = yield* githubFor();
      const expected = yield* Repos.listCollaborators
        .items({ owner, repo: fixtureNames[2]!, per_page: 100 })
        .pipe(Stream.runCollect, github);
      expect(expected.length).toBeGreaterThan(0);
      const provider = yield* Provider.findProvider(GitHub.Collaborator);
      const listed = yield* provider.list();
      for (const member of expected) {
        expect(
          listed.some((collaborator) => collaborator.username === member.login),
        ).toBe(true);
      }
      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);

test(
  "unit: owner allowlist rejects production and unrelated owners",
  Effect.sync(() => {
    expect(requireTestOwner("alchemy-run-test")).toBe("alchemy-run-test");
    expect(requireTestOwner("alchemy-run-test-2")).toBe("alchemy-run-test-2");
    for (const unsafe of ["alchemy-run", "sam-goodwin", "", "other-org"]) {
      expect(() => requireTestOwner(unsafe)).toThrow(
        "Refusing GitHub collaborator tests",
      );
    }
  }),
);
