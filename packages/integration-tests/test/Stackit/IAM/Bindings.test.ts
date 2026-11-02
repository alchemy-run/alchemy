import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as authorization from "@distilled.cloud/stackit/authorization";
import * as serviceAccount from "@distilled.cloud/stackit/service_account";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { stackitTags } from "../helpers.ts";
import IamBindingsWorker, { InspectedRole, Subject } from "./fixtures/worker.ts";

const providers = Layer.mergeAll(Stackit.providers(), Cloudflare.providers());

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers,
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "StackitIamBindingsStack",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const worker = yield* IamBindingsWorker;
    const subject = yield* Subject;
    const role = yield* InspectedRole;
    const key = yield* Stackit.IAM.ServiceAccountKey("IamBindingsSubjectKey", {
      serviceAccountEmail: subject.email,
    });
    const membership = yield* Stackit.IAM.Membership("IamBindingsSubjectReader", {
      subject: subject.email,
      role: "reader",
      resourceType: "project",
      resourceId: subject.projectId,
    });
    return {
      url: worker.url.as<string>(),
      projectId: subject.projectId,
      subjectEmail: subject.email,
      keyId: key.keyId,
      roleId: role.roleId,
      roleName: role.name,
      memberRole: membership.role,
    };
  }),
);

type Body = { ok: boolean; result?: any; error?: string };

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

const permissionNames = (role: authorization.Role) =>
  role.permissions.map((permission) => permission.name).sort();

describe(
  "STACKIT IAM bindings",
  { tags: [...stackitTags("iam", "bindings"), "provider:cloudflare"] },
  () => {
    const stack = beforeAll(deploy(Stack), { timeout: 300_000 });
    afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 300_000 });

    // A fresh workers.dev URL, the created key and the account's new memberships
    // take a while to propagate: retry until the route answers `ok`, then report
    // the last answer so a real failure shows its STACKIT error.
    const call = (route: string) =>
      Effect.gen(function* () {
        const { url } = yield* stack;
        return yield* HttpClient.get(`${url}${route}`).pipe(
          Effect.timeout("20 seconds"),
          Effect.flatMap((response) => response.json),
          Effect.map((body) => body as Body),
          Effect.flatMap((body) => (body?.ok ? Effect.succeed(body) : Effect.fail(body))),
          Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }),
          Effect.catch((body) => Effect.succeed(body as Body)),
        );
      });

    /** Out-of-band: the Worker's own account, the one holding the custom roles. */
    const workerAccount = Effect.gen(function* () {
      const { projectId } = yield* stack;
      const scope = { resourceType: "project", resourceId: projectId };
      const { roles } = yield* authorization.listRoles(scope);
      const custom = roles.find(
        (role) =>
          role.id !== undefined && permissionNames(role).join() === "iam.role.get,iam.role.list",
      );
      expect(custom?.name).toBeTruthy();
      const { members } = yield* authorization.listMembers(scope);
      const subject = members.find((member) => member.role === custom!.name)?.subject;
      expect(subject).toMatch(/@sa\.stackit\.cloud$/);
      return subject!;
    });

    describe("ListMembers", () => {
      test.provider(
        "lists the subject's role on the bound project, and only that subject",
        (_stack) =>
          Effect.gen(function* () {
            const { subjectEmail, memberRole } = yield* stack;
            const body = yield* call(`/members?email=${encodeURIComponent(subjectEmail!)}`);
            expectOk(body);
            expect(body.result.members.length).toBeGreaterThan(0);
            for (const member of body.result.members) {
              expect(member.subject).toBe(subjectEmail);
            }
            expect(body.result.members.map((member: any) => member.role)).toContain(memberRole);
          }),
        { timeout: 240_000 },
      );
    });

    describe("ListRoles", () => {
      test.provider(
        "lists the custom role defined on the bound project",
        (_stack) =>
          Effect.gen(function* () {
            const { projectId, roleName } = yield* stack;
            const body = yield* call("/roles");
            expectOk(body);
            expect(body.result.resourceId).toBe(projectId);
            expect(body.result.roles.map((role: any) => role.name)).toContain(roleName);
          }),
        { timeout: 240_000 },
      );
    });

    describe("GetRole", () => {
      test.provider(
        "reads the bound custom role",
        (_stack) =>
          Effect.gen(function* () {
            const { roleId, roleName } = yield* stack;
            const body = yield* call("/role");
            expectOk(body);
            expect(body.result.role.id).toBe(roleId);
            expect(body.result.role.name).toBe(roleName);
            expect(permissionNames(body.result.role)).toEqual(["iam.role.get"]);
          }),
        { timeout: 240_000 },
      );
    });

    describe("ListPermissions", () => {
      test.provider(
        "lists the permissions available on a project",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/permissions");
            expectOk(body);
            expect(body.result.permissions.map((permission: any) => permission.name)).toContain(
              "iam.member.get",
            );
          }),
        { timeout: 240_000 },
      );
    });

    describe("ListUserMemberships", () => {
      test.provider(
        "lists the Worker's own memberships on the bound project",
        (_stack) =>
          Effect.gen(function* () {
            const { projectId } = yield* stack;
            const self = yield* workerAccount;
            const { members } = yield* authorization.listMembers({
              resourceType: "project",
              resourceId: projectId!,
              subject: self,
            });
            const body = yield* call(`/user-memberships?email=${encodeURIComponent(self)}`);
            expectOk(body);
            for (const item of body.result.items) {
              expect(item.subject).toBe(self);
              expect(item.resourceId).toBe(projectId);
            }
            expect(body.result.items.map((item: any) => item.role).sort()).toEqual(
              members.map((member) => member.role).sort(),
            );
          }),
        { timeout: 240_000 },
      );
    });

    describe("ListUserPermissions", () => {
      test.provider(
        "answers which of the asked permissions the Worker holds on the bound project",
        (_stack) =>
          Effect.gen(function* () {
            const { projectId } = yield* stack;
            const self = yield* workerAccount;
            const email = encodeURIComponent(self);
            const held = yield* call(`/user-permissions?email=${email}&permission=iam.member.get`);
            expectOk(held);
            expect(held.result.items.map((item: any) => item.resourceId)).toEqual([projectId]);

            // The Worker holds no such permission, so nothing may come back.
            const absent = yield* call(
              `/user-permissions?email=${email}&permission=iam.member.add`,
            );
            expectOk(absent);
            expect(absent.result.items).toEqual([]);
          }),
        { timeout: 240_000 },
      );
    });

    describe("GetJWKS", () => {
      test.provider(
        "returns the bound account's public keys",
        (_stack) =>
          Effect.gen(function* () {
            const { subjectEmail } = yield* stack;
            const body = yield* call("/jwks");
            expectOk(body);
            expect(body.result.keys.length).toBeGreaterThan(0);

            const expected = yield* serviceAccount.getJWKS({ serviceAccountEmail: subjectEmail! });
            expect(body.result.keys).toEqual(expected.keys);
          }),
        { timeout: 240_000 },
      );
    });

    describe("ListServiceAccountKeys", () => {
      test.provider(
        "lists the bound account's key without its private half",
        (_stack) =>
          Effect.gen(function* () {
            const { keyId } = yield* stack;
            const body = yield* call("/keys");
            expectOk(body);
            expect(body.result.items.map((key: any) => key.id)).toContain(keyId);
            expect(JSON.stringify(body.result)).not.toContain("privateKey");
          }),
        { timeout: 240_000 },
      );
    });

    describe("grants", () => {
      test.provider(
        "the Worker's account holds only the custom roles its bindings need",
        (_stack) =>
          Effect.gen(function* () {
            const { projectId } = yield* stack;
            const self = yield* workerAccount;
            const scope = { resourceType: "project", resourceId: projectId! };
            const { roles } = yield* authorization.listRoles(scope);
            const { members } = yield* authorization.listMembers({ ...scope, subject: self });
            const held = members
              .map((member) => roles.find((role) => role.name === member.role))
              .map((role) => (role === undefined ? "unknown" : permissionNames(role).join()))
              .sort();
            expect(held).toEqual([
              "iam.member.get",
              "iam.role.get",
              "iam.role.get,iam.role.list",
              "iam.service-account-key.list",
            ]);
          }),
        { timeout: 120_000 },
      );
    });
  },
);
