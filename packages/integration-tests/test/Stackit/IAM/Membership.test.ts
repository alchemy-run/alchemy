import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as authorization from "@distilled.cloud/stackit/authorization";
import * as serviceAccount from "@distilled.cloud/stackit/service_account";
import { adopt } from "alchemy/AdoptPolicy";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";

const { test } = makeStackitTest();

const options = { tags: stackitTags("iam", "membership"), timeout: 180_000 } as const;

/**
 * Out-of-band subject: a throwaway service account with a deterministic
 * name, reused across runs and deleted at the end of each case. Memberships
 * on it can never lock anyone out of the test project.
 */
const ensureSubject = (projectId: string, name: string) =>
  Effect.gen(function* () {
    const { items } = yield* serviceAccount.listServiceAccounts({ projectId });
    const existing = items.find((account) => account.email.startsWith(`${name}-`));
    if (existing !== undefined) return existing.email;
    const created = yield* serviceAccount.createServiceAccount({ projectId, name });
    return created.email;
  });

const deleteSubject = (projectId: string, email: string) =>
  serviceAccount
    .deleteServiceAccount({ projectId, serviceAccountEmail: email })
    .pipe(Effect.catchTag("NotFound", () => Effect.void));

const rolesOf = (projectId: string, subject: string) =>
  authorization.listMembers({ resourceType: "project", resourceId: projectId, subject }).pipe(
    Effect.map((response) =>
      response.members
        .filter((member) => member.subject.toLowerCase() === subject.toLowerCase())
        .map((member) => member.role)
        .sort(),
    ),
  );

/** Typed, bounded wait until the member list matches `expected`. */
const waitForRoles = (projectId: string, subject: string, expected: string[]) =>
  rolesOf(projectId, subject).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (roles) => roles.join(",") === [...expected].sort().join(","),
      times: 15,
    }),
  );

test.provider(
  "grant, replace on role change, and revoke a project membership",
  (stack) =>
    Effect.gen(function* () {
      const { projectId } = yield* stackitEnvironment;
      yield* stack.destroy();
      const subject = yield* ensureSubject(projectId, "alc-iam-member");

      yield* Effect.gen(function* () {
        const reader = yield* stack.deploy(
          Stackit.IAM.Membership("Member", { subject, role: "reader" }),
        );
        expect(reader).toEqual({
          subject,
          role: "reader",
          resourceType: "project",
          resourceId: projectId,
        });
        expect(yield* rolesOf(projectId, subject)).toEqual(["reader"]);

        // Redeploying unchanged is a no-op.
        const plan = yield* stack.plan(
          Stackit.IAM.Membership("Member", { subject, role: "reader" }),
        );
        expect(plan.resources.Member).toMatchObject({ action: "noop" });

        // A role change replaces: grant `editor`, then revoke `reader`.
        const replacePlan = yield* stack.plan(
          Stackit.IAM.Membership("Member", { subject, role: "editor" }),
        );
        expect(replacePlan.resources.Member).toMatchObject({ action: "replace" });
        const editor = yield* stack.deploy(
          Stackit.IAM.Membership("Member", { subject, role: "editor" }),
        );
        expect(editor.role).toEqual("editor");
        expect(yield* waitForRoles(projectId, subject, ["editor"])).toEqual(["editor"]);

        // An explicit resourceId equal to the default resolves to the same scope.
        const explicit = yield* stack.deploy(
          Stackit.IAM.Membership("Member", {
            subject,
            role: "editor",
            resourceType: "project",
            resourceId: projectId,
          }),
        );
        expect(explicit.resourceId).toEqual(projectId);
        expect(yield* rolesOf(projectId, subject)).toEqual(["editor"]);

        yield* stack.destroy();
        expect(yield* waitForRoles(projectId, subject, [])).toEqual([]);
      }).pipe(Effect.ensuring(deleteSubject(projectId, subject).pipe(Effect.ignore)));
    }).pipe(logLevel),
  options,
);

test.provider(
  "a pre-existing membership is unowned until adopted",
  (stack) =>
    Effect.gen(function* () {
      const { projectId } = yield* stackitEnvironment;
      yield* stack.destroy();
      const subject = yield* ensureSubject(projectId, "alc-iam-adopt");

      yield* Effect.gen(function* () {
        // Grant out-of-band, as if from the console.
        yield* authorization.addMembers({
          resourceId: projectId,
          resourceType: "project",
          members: [{ subject, role: "reader" }],
        });
        expect(yield* waitForRoles(projectId, subject, ["reader"])).toEqual(["reader"]);

        const membership = Stackit.IAM.Membership("Adopted", { subject, role: "reader" });
        const error = yield* stack.plan(membership).pipe(Effect.flip);
        expect(error._tag).toEqual("OwnedBySomeoneElse");

        const adopted = yield* stack.deploy(membership.pipe(adopt(true)));
        expect(adopted.role).toEqual("reader");
        expect(adopted.resourceId).toEqual(projectId);

        // Once adopted, destroy revokes it.
        yield* stack.destroy();
        expect(yield* waitForRoles(projectId, subject, [])).toEqual([]);
      }).pipe(Effect.ensuring(deleteSubject(projectId, subject).pipe(Effect.ignore)));
    }).pipe(logLevel),
  options,
);

test.provider(
  "a folder membership without resourceId fails at plan",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const error = yield* stack
        .plan(
          Stackit.IAM.Membership("NoFolder", {
            subject: "nobody@example.com",
            role: "reader",
            resourceType: "folder",
          }),
        )
        .pipe(Effect.flip);
      expect(error._tag).toEqual("ConfigError");
      yield* stack.destroy();
    }).pipe(logLevel),
  { ...options, timeout: 60_000 },
);
