import * as Infisical from "@alchemy.run/infisical";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as infisical from "@distilled.cloud/infisical";
import { isActionState, State } from "alchemy/State/State";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Infisical.providers() });

const issuer = "https://token.actions.githubusercontent.com";
const trust = { oidcDiscoveryUrl: issuer, boundIssuer: issuer };
const oidcDefaults = {
  ...trust,
  boundAudiences: "",
  boundSubject: "",
  boundClaims: {},
  claimMetadataMapping: {},
  caCert: "",
  accessTokenTTL: 2592000,
  accessTokenMaxTTL: 2592000,
  accessTokenNumUsesLimit: 0,
  accessTokenTrustedIps: [
    { ipAddress: "0.0.0.0", type: "ipv4", prefix: 0 },
    { ipAddress: "::", type: "ipv6", prefix: 0 },
  ],
};

// Runs against an existing project, given by its UUID.
describe.skipIf(!process.env.INFISICAL_TEST || !process.env.INFISICAL_TEST_PROJECT)(
  "ProjectIdentity",
  { tags: ["provider:infisical", "provider:infisical:projectidentity", "live"] },
  () => {
    test.provider(
      "converges roles and OIDC, repairs drift, recovers, and deletes",
      (stack) =>
        Effect.gen(function* () {
          const project = yield* Config.String("INFISICAL_TEST_PROJECT");
          const program = (
            roles: Infisical.ProjectIdentityProps["roles"],
            oidcAuth: Infisical.OidcAuth = trust,
            name = "alchemy-project-identity",
          ) => Infisical.ProjectIdentity("Identity", { project, name, roles, oidcAuth });

          yield* stack.destroy();
          const first = yield* stack.deploy(program(["viewer"]));
          expect(first.project).toBe(project);
          expect(first.name).toMatch(/^alchemy-project-identity-[a-z2-7]{16}$/);
          yield* verify(first, ["viewer"], oidcDefaults);

          const redeployed = yield* stack.deploy(program(["viewer"]));
          expect(redeployed.id).toBe(first.id);
          yield* verify(redeployed, ["viewer"], oidcDefaults);

          const changedAuth = {
            ...trust,
            boundAudiences: ["https://github.com/alchemy-run"],
            boundSubject: "repo:alchemy-run/alchemy:ref:refs/heads/main",
            boundClaims: { repository: "alchemy-run/alchemy" },
            claimMetadataMapping: { repository: "repository" },
            accessTokenTTL: 600,
            accessTokenMaxTTL: 1200,
            accessTokenNumUsesLimit: 3,
          };
          const expectedAuth = {
            ...oidcDefaults,
            ...changedAuth,
            boundAudiences: "https://github.com/alchemy-run",
          };
          const changed = () =>
            program(["member"], changedAuth, "alchemy-project-identity-updated");
          const updated = yield* stack.deploy(changed());
          expect(updated.id).toBe(first.id);
          expect(updated.name).toBe(
            first.name.replace("alchemy-project-identity-", "alchemy-project-identity-updated-"),
          );
          yield* verify(updated, ["member"], expectedAuth);

          yield* infisical.updateOidcAuth({
            identityId: updated.id,
            boundSubject: "repo:alchemy-run/alchemy:ref:refs/heads/drifted",
          });
          const drifted = yield* infisical.getOidcAuth({ identityId: updated.id });
          expect(drifted.identityOidcAuth.boundSubject).toBe(
            "repo:alchemy-run/alchemy:ref:refs/heads/drifted",
          );
          const repaired = yield* stack.deploy(changed());
          expect(repaired.id).toBe(first.id);
          yield* verify(repaired, ["member"], expectedAuth);

          const reset = yield* stack.deploy(program(["viewer"]));
          expect(reset.id).toBe(first.id);
          yield* verify(reset, ["viewer"], oidcDefaults);

          yield* infisical.deleteProjectMachineIdentity({
            projectId: project,
            identityId: reset.id,
          });
          expect(yield* exists(project, reset.id)).toBe(false);
          const recovered = yield* stack.deploy(program(["viewer"]));
          expect(recovered.id).not.toBe(reset.id);
          yield* verify(recovered, ["viewer"], oidcDefaults);

          // A create whose attributes never reached state: deploy finds the
          // identity by its instance suffix and keeps it.
          yield* forgetAttributes(stack);
          const found = yield* stack.deploy(program(["viewer"]));
          expect(found.id).toBe(recovered.id);

          // The same lost create, then destroy: the identity is deleted.
          yield* forgetAttributes(stack);
          yield* stack.destroy();
          expect(yield* exists(project, recovered.id)).toBe(false);
        }),
      { timeout: 120_000 },
    );
  },
);

const verify = Effect.fn(function* (
  output: Infisical.ProjectIdentityAttributes,
  roles: readonly string[],
  oidc: typeof oidcDefaults,
) {
  const { identity } = yield* infisical.getProjectMachineIdentityById({
    projectId: output.project,
    identityId: output.id,
  });
  expect(identity).toMatchObject({ id: output.id, projectId: output.project, name: output.name });
  expect(identity.authMethods).toContain("oidc-auth");

  const { identityMembership } = yield* infisical.getProjectIdentityMembership({
    projectId: output.project,
    identityId: output.id,
  });
  expect(identityMembership).toMatchObject({
    identityId: output.id,
    project: { id: output.project },
  });
  expect(
    identityMembership.roles
      .map((role) => ({ role: role.customRoleSlug ?? role.role, isTemporary: role.isTemporary }))
      .toSorted((a, b) => a.role.localeCompare(b.role)),
  ).toEqual(roles.toSorted().map((role) => ({ role, isTemporary: false })));

  const { identityOidcAuth } = yield* infisical.getOidcAuth({ identityId: output.id });
  expect(identityOidcAuth).toMatchObject({ identityId: output.id, ...oidc });
});

const exists = (project: string, id: string) =>
  infisical.getProjectMachineIdentityById({ projectId: project, identityId: id }).pipe(
    Effect.as(true),
    Effect.catchTag("NotFound", () => Effect.succeed(false)),
  );

/**
 * Reproduce a create whose response or state write was lost: the identity
 * exists in Infisical, but its row is still `creating`, with no attributes.
 */
const forgetAttributes = (stack: Test.ScratchStack) =>
  Effect.gen(function* () {
    const state = yield* yield* State;
    const address = { stack: stack.name, stage: stack.stage, fqn: "Identity" };
    const stored = yield* state.get(address);
    if (
      !stored ||
      isActionState(stored) ||
      (stored.status !== "created" && stored.status !== "updated")
    ) {
      return yield* Effect.die(new Error("Expected a deployed Identity row"));
    }
    const { attr: _, ...rest } = stored;
    yield* state.set({ ...address, value: { ...rest, status: "creating" } });
  }).pipe(Effect.provide(stack.state));
