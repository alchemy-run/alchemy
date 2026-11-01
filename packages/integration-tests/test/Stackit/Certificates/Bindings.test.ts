import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as authorization from "@distilled.cloud/stackit/authorization";
import * as certificates from "@distilled.cloud/stackit/certificates";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { stackitTags } from "../helpers.ts";
import { CERT_B_PEM, KEY_B_PEM } from "./fixtures/certs.ts";
import CertificatesBindingsWorker, { Tls } from "./fixtures/worker.ts";

const providers = Layer.mergeAll(Stackit.providers(), Cloudflare.providers());

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers,
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "StackitCertificatesBindingsStack",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const worker = yield* CertificatesBindingsWorker;
    const certificate = yield* Tls;
    return {
      url: worker.url.as<string>(),
      projectId: certificate.projectId,
      region: certificate.region,
      certificateId: certificate.certificateId,
      certificateName: certificate.certificateName,
    };
  }),
);

type Body = { ok: boolean; result?: any; error?: string };

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

describe.sequential(
  "STACKIT Certificates bindings on a Cloudflare Worker",
  { tags: [...stackitTags("certificates", "bindings"), "provider:cloudflare"] },
  () => {
    const stack = beforeAll(deploy(Stack), { timeout: 600_000 });
    afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 600_000 });

    // A fresh workers.dev URL, the created key and the account's memberships take a while to
    // propagate: retry until the route answers `ok`, then report the last answer so a real
    // failure shows its STACKIT error.
    const call = (route: string, params: Record<string, string> = {}) =>
      Effect.gen(function* () {
        const { url } = yield* stack;
        const query = new URLSearchParams(params).toString();
        return yield* HttpClient.get(`${url}${route}?${query}`).pipe(
          Effect.timeout("20 seconds"),
          Effect.flatMap((response) => response.json),
          Effect.map((body) => body as Body),
          Effect.flatMap((body) => (body?.ok ? Effect.succeed(body) : Effect.fail(body))),
          Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }),
          Effect.catch((body) => Effect.succeed(body as Body)),
        );
      });

    /** The stack's project and region, for out-of-band calls. */
    const scope = Effect.gen(function* () {
      const { projectId, region } = yield* stack;
      return { projectId: projectId!, region: region! };
    });

    describe("CreateCertificate", () => {
      test.provider(
        "stores a certificate, seen out of band",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/create-certificate", { name: "bindings-created" });
            expectOk(body);
            const id = body.result.id as string;
            const where = yield* scope;
            const live = yield* certificates.getCertificate({ ...where, id });
            expect(live.name).toEqual("bindings-created");
            expect(JSON.stringify(body.result)).not.toContain("PRIVATE KEY");
            yield* certificates.deleteCertificate({ ...where, id });
          }),
        { timeout: 240_000 },
      );
    });

    describe("GetCertificate", () => {
      test.provider(
        "reads the bound certificate and its validity",
        (_stack) =>
          Effect.gen(function* () {
            const { certificateId } = yield* stack;
            const body = yield* call("/get-certificate");
            expectOk(body);
            expect(body.result.id).toEqual(certificateId);
            expect(body.result.data.notAfter).toEqual(expect.any(String));
          }),
        { timeout: 240_000 },
      );
    });

    describe("ListCertificates", () => {
      test.provider(
        "lists the project's certificates, including the bound one",
        (_stack) =>
          Effect.gen(function* () {
            const { certificateId } = yield* stack;
            const body = yield* call("/list-certificates");
            expectOk(body);
            const ids = (body.result.items as { id: string }[]).map((item) => item.id);
            expect(ids).toContain(certificateId);
          }),
        { timeout: 240_000 },
      );
    });

    describe("DeleteCertificate", () => {
      test.provider(
        "deletes a certificate by id",
        (_stack) =>
          Effect.gen(function* () {
            const where = yield* scope;
            const seeded = yield* certificates.createCertificate({
              ...where,
              name: "bindings-deleted",
              publicKey: CERT_B_PEM,
              privateKey: Redacted.make(KEY_B_PEM),
            });
            const body = yield* call("/delete-certificate", { id: seeded.id! });
            expectOk(body);
            const gone = yield* certificates.getCertificate({ ...where, id: seeded.id! }).pipe(
              Effect.map(() => "present" as const),
              Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
            );
            expect(gone).toEqual("gone");
          }),
        { timeout: 240_000 },
      );
    });

    describe("GetQuota", () => {
      test.provider(
        "reports a limit and the usage, at least the bound certificate",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/get-quota");
            expectOk(body);
            expect(body.result.quotas.certificates.limit).toBeGreaterThan(0);
            expect(body.result.quotas.certificates.usage).toBeGreaterThan(0);
          }),
        { timeout: 240_000 },
      );
    });

    describe("grants", () => {
      test.provider(
        "the worker's account holds only the certificate permissions it needs",
        (_stack) =>
          Effect.gen(function* () {
            const { projectId } = yield* stack;
            const where = { resourceType: "project", resourceId: projectId! };
            const { roles } = yield* authorization.listRoles(where);
            const permissionsOf = (role: authorization.Role) =>
              role.permissions.map((permission) => permission.name).join();
            const get = roles.find(
              (role) =>
                role.id !== undefined &&
                permissionsOf(role) === "alb.certificateservice.certificate.get",
            );
            expect(get?.name).toBeTruthy();

            const { members } = yield* authorization.listMembers(where);
            const self = members.find((member) => member.role === get!.name)?.subject;
            expect(self).toMatch(/@sa\.stackit\.cloud$/);

            const held = members
              .filter((member) => member.subject === self)
              .map((member) => roles.find((role) => role.name === member.role))
              .map((role) => (role === undefined ? "unknown" : permissionsOf(role)))
              .sort();
            expect(held).toEqual([
              "alb.certificateservice.certificate.create",
              "alb.certificateservice.certificate.delete",
              "alb.certificateservice.certificate.get",
              "alb.certificateservice.certificate.list",
              "alb.certificateservice.quota.get",
            ]);
          }),
        { timeout: 120_000 },
      );
    });
  },
);
