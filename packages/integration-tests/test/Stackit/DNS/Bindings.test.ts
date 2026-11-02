import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as authorization from "@distilled.cloud/stackit/authorization";
import * as dns from "@distilled.cloud/stackit/dns";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { stackitTags } from "../helpers.ts";
import DnsBindingsWorker, { Domain, Secondary } from "./fixtures/worker.ts";

const providers = Layer.mergeAll(Stackit.providers(), Cloudflare.providers());

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers,
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "StackitDnsBindingsStack",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const worker = yield* DnsBindingsWorker;
    const domain = yield* Domain;
    const secondary = yield* Secondary;
    return {
      url: worker.url.as<string>(),
      zoneId: domain.zoneId,
      projectId: domain.projectId,
      dnsName: domain.dnsName,
      secondaryZoneId: secondary.zoneId,
    };
  }),
);

type Body = { ok: boolean; result?: any; error?: string };

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

// Record set writes in one zone may be rejected while the zone is updating, so
// the bindings run one after another.
describe.sequential(
  "STACKIT DNS bindings on a Cloudflare Worker",
  { tags: [...stackitTags("dns", "bindings"), "provider:cloudflare"] },
  () => {
    const stack = beforeAll(deploy(Stack), { timeout: 600_000 });
    afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 600_000 });

    // A fresh workers.dev URL, the created key and the account's memberships take
    // a while to propagate: retry until the route answers `ok`, then report the
    // last answer so a real failure shows its STACKIT error.
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

    /** The record set STACKIT reports under a name, without the trailing dot. */
    const observeByName = (name: string) =>
      Effect.gen(function* () {
        const { projectId, zoneId, dnsName } = yield* stack;
        const fqdn = `${name}.${dnsName}`;
        const { rrSets } = yield* dns.listRecordSets({
          projectId: projectId!,
          zoneId: zoneId!,
          name_like_: name,
        });
        return rrSets.find((rrset) => rrset.name.replace(/\.$/, "") === fqdn);
      });

    /** A record set created out of band, settled, for a binding to act on. */
    const seedRecordSet = (name: string, content: string) =>
      Effect.gen(function* () {
        const { projectId, zoneId } = yield* stack;
        const { rrset } = yield* dns.createRecordSet({
          projectId: projectId!,
          zoneId: zoneId!,
          name,
          type: "TXT",
          ttl: 60,
          records: [{ content }],
        });
        yield* dns.getRecordSet({ projectId: projectId!, zoneId: zoneId!, rrSetId: rrset.id }).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("3 seconds"),
            until: ({ rrset: observed }) => observed.state === "CREATE_SUCCEEDED",
            times: 20,
          }),
        );
        return rrset;
      });

    /** Bounded wait until a record set reports a settled state with `records`. */
    const waitForContents = (rrSetId: string, contents: readonly string[]) =>
      Effect.gen(function* () {
        const { projectId, zoneId } = yield* stack;
        const expected = [...contents].sort();
        return yield* dns.getRecordSet({ projectId: projectId!, zoneId: zoneId!, rrSetId }).pipe(
          Effect.map(({ rrset }) => rrset),
          Effect.repeat({
            schedule: Schedule.spaced("3 seconds"),
            until: (rrset) =>
              JSON.stringify(rrset.records.map((record) => record.content).sort()) ===
              JSON.stringify(expected),
            times: 20,
          }),
        );
      });

    describe("GetZone", () => {
      test.provider(
        "reads the bound zone",
        (_stack) =>
          Effect.gen(function* () {
            const { zoneId, dnsName } = yield* stack;
            const body = yield* call("/get-zone");
            expectOk(body);
            expect(body.result.zone.id).toBe(zoneId);
            expect(body.result.zone.dnsName).toBe(dnsName);
          }),
        { timeout: 240_000 },
      );
    });

    describe("GetRecordSet", () => {
      test.provider(
        "reads a record set of the bound zone by id",
        (_stack) =>
          Effect.gen(function* () {
            const seeded = yield* seedRecordSet("bind-get", '"seeded"');
            const body = yield* call("/get-record-set", { id: seeded.id });
            expectOk(body);
            expect(body.result.rrset.id).toBe(seeded.id);
          }),
        { timeout: 240_000 },
      );
    });

    describe("ListRecordSets", () => {
      test.provider(
        "lists the bound zone's record sets",
        (_stack) =>
          Effect.gen(function* () {
            const seeded = yield* seedRecordSet("bind-list", '"seeded"');
            const body = yield* call("/list-record-sets", { name: "bind-list" });
            expectOk(body);
            expect(body.result.rrSets.map((rrset: { id: string }) => rrset.id)).toContain(
              seeded.id,
            );
          }),
        { timeout: 240_000 },
      );
    });

    describe("ExportRecordSets", () => {
      test.provider(
        "exports the bound zone's record sets",
        (_stack) =>
          Effect.gen(function* () {
            yield* seedRecordSet("bind-export", '"seeded"');
            const body = yield* call("/export-record-sets");
            expectOk(body);
            expect(
              body.result.rrSets.some((rrset: { name?: string }) =>
                rrset.name?.includes("bind-export"),
              ),
            ).toBe(true);
          }),
        { timeout: 240_000 },
      );
    });

    describe("CreateRecordSet", () => {
      test.provider(
        "creates a record set visible out of band",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/create-record-set", {
              name: "bind-create",
              content: '"created"',
            });
            expectOk(body);
            const observed = yield* observeByName("bind-create");
            expect(observed?.id).toBe(body.result.rrset.id);
            expect(observed?.records.map((record) => record.content)).toEqual(['"created"']);
          }),
        { timeout: 240_000 },
      );
    });

    describe("UpdateRecordSet", () => {
      test.provider(
        "replaces a record set's records",
        (_stack) =>
          Effect.gen(function* () {
            const seeded = yield* seedRecordSet("bind-update", '"before"');
            const body = yield* call("/update-record-set", {
              id: seeded.id,
              content: '"after"',
            });
            expectOk(body);
            const observed = yield* waitForContents(seeded.id, ['"after"']);
            expect(observed.records.map((record) => record.content)).toEqual(['"after"']);
          }),
        { timeout: 240_000 },
      );
    });

    describe("UpdateRecords", () => {
      test.provider(
        "adds one record and keeps the others",
        (_stack) =>
          Effect.gen(function* () {
            const seeded = yield* seedRecordSet("bind-records", '"first"');
            const body = yield* call("/update-records", {
              id: seeded.id,
              content: '"second"',
            });
            expectOk(body);
            const observed = yield* waitForContents(seeded.id, ['"first"', '"second"']);
            expect(observed.records.map((record) => record.content).sort()).toEqual([
              '"first"',
              '"second"',
            ]);
          }),
        { timeout: 240_000 },
      );
    });

    describe("DeleteRecordSet", () => {
      test.provider(
        "deletes a record set",
        (_stack) =>
          Effect.gen(function* () {
            const { projectId, zoneId } = yield* stack;
            const seeded = yield* seedRecordSet("bind-delete", '"seeded"');
            const body = yield* call("/delete-record-set", { id: seeded.id });
            expectOk(body);
            const state = yield* dns
              .getRecordSet({ projectId: projectId!, zoneId: zoneId!, rrSetId: seeded.id })
              .pipe(
                Effect.map(({ rrset }) => rrset.state as string),
                Effect.catchTag("NotFound", () => Effect.succeed("gone")),
                Effect.repeat({
                  schedule: Schedule.spaced("3 seconds"),
                  until: (observed) => observed === "gone" || observed === "DELETE_SUCCEEDED",
                  times: 20,
                }),
              );
            expect(["gone", "DELETE_SUCCEEDED"]).toContain(state);
          }),
        { timeout: 240_000 },
      );
    });

    describe("ImportRecordSets", () => {
      test.provider(
        "upserts a record set",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/import-record-sets", {
              name: "bind-import",
              content: '"imported"',
            });
            expectOk(body);
            const observed = yield* observeByName("bind-import").pipe(
              Effect.repeat({
                schedule: Schedule.spaced("3 seconds"),
                until: (rrset) => rrset !== undefined,
                times: 20,
              }),
            );
            expect(observed?.records.map((record) => record.content)).toEqual(['"imported"']);
          }),
        { timeout: 240_000 },
      );
    });

    describe("RetrieveZone", () => {
      test.provider(
        "queues a transfer of the bound secondary zone",
        (_stack) =>
          Effect.gen(function* () {
            const { projectId, secondaryZoneId } = yield* stack;
            const body = yield* call("/retrieve-zone");
            expectOk(body);
            const { zone } = yield* dns.getZone({
              projectId: projectId!,
              zoneId: secondaryZoneId!,
            });
            expect(zone.type).toBe("secondary");
          }),
        { timeout: 240_000 },
      );
    });

    describe("ReadZone", () => {
      test.provider(
        "reads the zone and lists its record sets",
        (_stack) =>
          Effect.gen(function* () {
            const { zoneId } = yield* stack;
            const seeded = yield* seedRecordSet("bind-read-zone", '"seeded"');
            const body = yield* call("/read-zone", { name: "bind-read-zone" });
            expectOk(body);
            expect(body.result.zone.zone.id).toBe(zoneId);
            expect(body.result.listed.rrSets.map((rrset: { id: string }) => rrset.id)).toContain(
              seeded.id,
            );
          }),
        { timeout: 240_000 },
      );
    });

    describe("WriteZone", () => {
      test.provider(
        "creates a record set visible out of band",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/write-zone", {
              name: "bind-write-zone",
              content: '"written"',
            });
            expectOk(body);
            const observed = yield* observeByName("bind-write-zone");
            expect(observed?.id).toBe(body.result.rrset.id);
          }),
        { timeout: 240_000 },
      );
    });

    describe("ReadWriteZone", () => {
      test.provider(
        "creates a record set and reads it back",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/read-write-zone", {
              name: "bind-read-write-zone",
              content: '"written"',
            });
            expectOk(body);
            expect(body.result.rrset.records[0].content).toBe('"written"');
            const observed = yield* observeByName("bind-read-write-zone");
            expect(observed?.id).toBe(body.result.rrset.id);
          }),
        { timeout: 240_000 },
      );
    });

    describe("Lookup", () => {
      test.provider(
        "resolves a name on the STACKIT resolvers",
        (_stack) =>
          Effect.gen(function* () {
            const { dnsName } = yield* stack;
            const body = yield* call("/lookup", { address: dnsName! });
            expectOk(body);
            expect(body.result.state).toBeDefined();
          }),
        { timeout: 240_000 },
      );
    });

    describe("FlushCache", () => {
      test.provider(
        "flushes a name from the STACKIT resolvers",
        (_stack) =>
          Effect.gen(function* () {
            const { dnsName } = yield* stack;
            const body = yield* call("/flush-cache", { domain: dnsName! });
            expectOk(body);
          }),
        { timeout: 240_000 },
      );
    });

    test.provider(
      "the created account holds only the DNS permissions",
      (_stack) =>
        Effect.gen(function* () {
          const { projectId } = yield* stack;
          const scope = { resourceType: "project", resourceId: projectId! };
          const { roles } = yield* authorization.listRoles(scope);
          const permissionsOf = (role: authorization.Role) =>
            role.permissions
              .map((permission) => permission.name)
              .sort()
              .join();
          const read = roles.find(
            (role) => role.id !== undefined && permissionsOf(role) === "dns.zone.list",
          );
          expect(read?.name).toBeTruthy();

          const { members } = yield* authorization.listMembers(scope);
          const self = members.find((member) => member.role === read!.name)?.subject;
          expect(self).toMatch(/@sa\.stackit\.cloud$/);

          const held = members
            .filter((member) => member.subject === self)
            .map((member) => roles.find((role) => role.name === member.role))
            .map((role) => (role === undefined ? "unknown" : permissionsOf(role)))
            .sort();
          expect(held).toEqual([
            "dns.zone.create",
            "dns.zone.create,dns.zone.list",
            "dns.zone.list",
          ]);
        }),
      { timeout: 120_000 },
    );
  },
);
