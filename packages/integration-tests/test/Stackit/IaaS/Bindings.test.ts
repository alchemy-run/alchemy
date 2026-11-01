import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as authorization from "@distilled.cloud/stackit/authorization";
import * as iaas from "@distilled.cloud/stackit/iaas";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { stackitTags } from "../helpers.ts";
import { slow, ubuntuImageId } from "./compute.ts";
import IaasBindingsWorker, { Address, DataBackup, Nic, Web } from "./fixtures/worker.ts";

const providers = Layer.mergeAll(Stackit.providers(), Cloudflare.providers());

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers,
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "StackitIaasBindingsStack",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const worker = yield* IaasBindingsWorker;
    const server = yield* Web;
    const backup = yield* DataBackup;
    const address = yield* Address;
    const nic = yield* Nic;
    return {
      url: worker.url.as<string>(),
      projectId: server.projectId,
      region: server.region,
      serverId: server.serverId,
      volumeId: backup.volumeId,
      publicIpId: address.publicIpId,
      nicId: nic.networkInterfaceId,
    };
  }),
);

type Body = { ok: boolean; result?: any; error?: string };

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

// The server is billed per hour and the backup takes minutes: gated behind
// STACKIT_TEST_SLOW, like the suites of the same resources. The steps act on one
// server, so they run in order.
describe.sequential.skipIf(slow)(
  "STACKIT IaaS bindings",
  { tags: [...stackitTags("iaas", "bindings"), "provider:cloudflare"] },
  () => {
    const stack = beforeAll(deploy(Stack), { timeout: 1_800_000 });
    afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 1_200_000 });

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

    /** Out-of-band: poll the server until it reports `status`. */
    const expectServerStatus = (status: string) =>
      Effect.gen(function* () {
        const { projectId, region, serverId } = yield* stack;
        const server = yield* iaas
          .getServer({
            projectId: projectId!,
            region: region!,
            serverId: serverId!,
          })
          .pipe(
            Effect.repeat({
              schedule: Schedule.spaced("10 seconds"),
              until: (server) => server.status === status,
              times: 30,
            }),
          );
        expect(server.status).toBe(status);
      });

    describe("RebootServer", () => {
      test.provider(
        "reboots the bound server, which comes back",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/reboot");
            expectOk(body);
            yield* expectServerStatus("ACTIVE");
          }),
        { timeout: 600_000 },
      );
    });

    describe("GetServerConsole", () => {
      test.provider(
        "returns a console URL",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/console");
            expectOk(body);
            expect(body.result.url).toMatch(/^https:\/\//);
          }),
        { timeout: 240_000 },
      );
    });

    describe("GetServerLog", () => {
      test.provider(
        "returns the console log of a booted server",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/log");
            expectOk(body);
            expect(body.result.output).toEqual(expect.any(String));
          }),
        { timeout: 240_000 },
      );
    });

    describe("RescueServer", () => {
      test.provider(
        "puts the bound server into rescue",
        (_stack) =>
          Effect.gen(function* () {
            const { projectId, region } = yield* stack;
            const image = yield* ubuntuImageId(projectId!, region!);
            const body = yield* call(`/rescue?image=${image}`);
            expectOk(body);
            yield* expectServerStatus("RESCUE");
          }),
        { timeout: 600_000 },
      );
    });

    describe("UnrescueServer", () => {
      test.provider(
        "boots the bound server normally again",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/unrescue");
            expectOk(body);
            yield* expectServerStatus("ACTIVE");
          }),
        { timeout: 600_000 },
      );
    });

    describe("RestoreBackup", () => {
      test.provider(
        "restores the backup onto its volume, which becomes available",
        (_stack) =>
          Effect.gen(function* () {
            const { projectId, region, volumeId } = yield* stack;
            const body = yield* call("/restore");
            expectOk(body);
            const volume = yield* iaas
              .getVolume({ projectId: projectId!, region: region!, volumeId: volumeId! })
              .pipe(
                Effect.repeat({
                  schedule: Schedule.spaced("10 seconds"),
                  until: (volume) => volume.status === "AVAILABLE",
                  times: 30,
                }),
              );
            expect(volume.status).toBe("AVAILABLE");
          }),
        { timeout: 600_000 },
      );
    });

    describe("AssociatePublicIp", () => {
      test.provider(
        "moves the bound address to an interface and detaches it",
        (_stack) =>
          Effect.gen(function* () {
            const { projectId, region, publicIpId, nicId } = yield* stack;
            const read = iaas.getPublicIP({
              projectId: projectId!,
              region: region!,
              publicIpId: publicIpId!,
            });

            const attached = yield* call(`/associate?nic=${nicId}`);
            expectOk(attached);
            expect((yield* read).networkInterface).toBe(nicId);

            const detached = yield* call("/associate");
            expectOk(detached);
            expect((yield* read).networkInterface ?? null).toBeNull();
          }),
        { timeout: 240_000 },
      );
    });

    describe("grants", () => {
      test.provider(
        "the Worker's account holds only one single-permission role per binding",
        (_stack) =>
          Effect.gen(function* () {
            const { projectId } = yield* stack;
            const scope = { resourceType: "project", resourceId: projectId! };
            const { roles } = yield* authorization.listRoles(scope);
            const permissionsOf = (role: authorization.Role) =>
              role.permissions.map((permission) => permission.name).join();
            const reboot = roles.find(
              (role) => role.id !== undefined && permissionsOf(role) === "iaas.server.reboot",
            );
            expect(reboot?.name).toBeTruthy();

            const { members } = yield* authorization.listMembers(scope);
            const self = members.find((member) => member.role === reboot!.name)?.subject;
            expect(self).toMatch(/@sa\.stackit\.cloud$/);

            const held = members
              .filter((member) => member.subject === self)
              .map((member) => roles.find((role) => role.name === member.role))
              .map((role) => (role === undefined ? "unknown" : permissionsOf(role)))
              .sort();
            expect(held).toEqual([
              "iaas.backup.restore",
              "iaas.public-ip.update",
              "iaas.server.console-log.get",
              "iaas.server.console-url.get",
              "iaas.server.reboot",
              "iaas.server.rescue",
              "iaas.server.unrescue",
            ]);
          }),
        { timeout: 120_000 },
      );
    });
  },
);
