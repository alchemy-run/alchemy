import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";

export const Domain = Stackit.DNS.Zone("DnsBindingsZone", {});

/** `retrieve` only makes sense on a secondary zone. */
export const Secondary = Stackit.DNS.Zone("DnsBindingsSecondaryZone", {
  type: "secondary",
  primaries: ["192.0.2.1"],
});

/**
 * A Cloudflare Worker with every DNS binding. One route per binding; each answers
 * `{ ok, result | error }` so a failure surfaces the STACKIT error in the test.
 */
export default class DnsBindingsWorker extends Cloudflare.Worker<DnsBindingsWorker>()(
  "StackitDnsBindingsWorker",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    const domain = yield* Domain;
    const secondary = yield* Secondary;
    const getZone = yield* Stackit.DNS.GetZone(domain);
    const getRecordSet = yield* Stackit.DNS.GetRecordSet(domain);
    const listRecordSets = yield* Stackit.DNS.ListRecordSets(domain);
    const exportRecordSets = yield* Stackit.DNS.ExportRecordSets(domain);
    const createRecordSet = yield* Stackit.DNS.CreateRecordSet(domain);
    const updateRecordSet = yield* Stackit.DNS.UpdateRecordSet(domain);
    const updateRecords = yield* Stackit.DNS.UpdateRecords(domain);
    const deleteRecordSet = yield* Stackit.DNS.DeleteRecordSet(domain);
    const importRecordSets = yield* Stackit.DNS.ImportRecordSets(domain);
    const retrieveZone = yield* Stackit.DNS.RetrieveZone(secondary);
    const readZone = yield* Stackit.DNS.ReadZone(domain);
    const writeZone = yield* Stackit.DNS.WriteZone(domain);
    const readWriteZone = yield* Stackit.DNS.ReadWriteZone(domain);
    const lookup = yield* Stackit.DNS.Lookup();
    const flushCache = yield* Stackit.DNS.FlushCache();

    const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
      effect.pipe(
        Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
        Effect.catchCause((cause) =>
          HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
        ),
      );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://worker");
        const param = (name: string) => url.searchParams.get(name) ?? "";
        const records = () => [{ content: param("content") }];
        switch (url.pathname) {
          case "/get-zone":
            return yield* respond(getZone({}));
          case "/get-record-set":
            return yield* respond(getRecordSet({ rrSetId: param("id") }));
          case "/list-record-sets":
            return yield* respond(listRecordSets({ name_like_: param("name") }));
          case "/export-record-sets":
            return yield* respond(exportRecordSets({ format: "json" }));
          case "/create-record-set":
            return yield* respond(
              createRecordSet({ name: param("name"), type: "TXT", ttl: 60, records: records() }),
            );
          case "/update-record-set":
            return yield* respond(updateRecordSet({ rrSetId: param("id"), records: records() }));
          case "/update-records":
            return yield* respond(
              updateRecords({ rrSetId: param("id"), action: "add", records: records() }),
            );
          case "/delete-record-set":
            return yield* respond(deleteRecordSet({ rrSetId: param("id") }));
          case "/import-record-sets":
            return yield* respond(
              importRecordSets({
                format: "json",
                importType: "upsert",
                rrSets: [
                  { name: param("name"), type: "TXT", ttl: 60, content: [param("content")] },
                ],
              }),
            );
          case "/retrieve-zone":
            return yield* respond(retrieveZone({}));
          case "/read-zone":
            return yield* respond(
              Effect.all({
                zone: readZone.getZone(),
                listed: readZone.listRecordSets({ name_like_: param("name") }),
              }),
            );
          case "/write-zone":
            return yield* respond(
              writeZone.createRecordSet({
                name: param("name"),
                type: "TXT",
                ttl: 60,
                records: records(),
              }),
            );
          case "/read-write-zone":
            return yield* respond(
              Effect.gen(function* () {
                const { rrset } = yield* readWriteZone.createRecordSet({
                  name: param("name"),
                  type: "TXT",
                  ttl: 60,
                  records: records(),
                });
                return yield* readWriteZone.getRecordSet({ rrSetId: rrset.id });
              }),
            );
          case "/lookup":
            return yield* respond(lookup({ address: param("address"), recordType: "SOA" }));
          case "/flush-cache":
            return yield* respond(flushCache({ domain: param("domain") }));
          default:
            return HttpServerResponse.text("ok");
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Stackit.DNS.GetZoneHttp,
        Stackit.DNS.GetRecordSetHttp,
        Stackit.DNS.ListRecordSetsHttp,
        Stackit.DNS.ExportRecordSetsHttp,
        Stackit.DNS.CreateRecordSetHttp,
        Stackit.DNS.UpdateRecordSetHttp,
        Stackit.DNS.UpdateRecordsHttp,
        Stackit.DNS.DeleteRecordSetHttp,
        Stackit.DNS.ImportRecordSetsHttp,
        Stackit.DNS.RetrieveZoneHttp,
        Stackit.DNS.ReadZoneHttp,
        Stackit.DNS.WriteZoneHttp,
        Stackit.DNS.ReadWriteZoneHttp,
        Stackit.DNS.LookupHttp,
        Stackit.DNS.FlushCacheHttp,
      ),
    ),
  ),
) {}
