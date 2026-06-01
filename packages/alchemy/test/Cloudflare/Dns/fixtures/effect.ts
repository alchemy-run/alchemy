import * as Cloudflare from "alchemy/Cloudflare";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Effect-native Worker fixture that exercises the {@link Cloudflare.DnsReadWrite}
 * binding (full DNS record CRUD).
 *
 * Binding `DnsReadWrite` in the Init phase provisions a scoped
 * {@link Cloudflare.AccountApiToken} (with `DNS Read` + `DNS Write` across all
 * zones) and binds its value into the Worker. The `/dns` route then drives a
 * self-contained create → get → list → update → delete scenario against the
 * zone passed in the query string.
 */
export default class DnsEffectWorker extends Cloudflare.Worker<DnsEffectWorker>()(
  "DnsEffectWorker",
  {
    main: import.meta.filename,
    compatibility: { date: "2024-09-23", flags: ["nodejs_compat"] },
  },
  Effect.gen(function* () {
    const dns = yield* Cloudflare.DnsReadWrite.bind();

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);

        if (url.pathname === "/dns") {
          const zoneId = url.searchParams.get("zoneId")!;
          const name = url.searchParams.get("name")!;

          return yield* Effect.gen(function* () {
            const created = yield* dns.createDnsRecord(zoneId, {
              type: "A",
              name,
              content: "192.0.2.1",
              ttl: 1,
            });
            const id = created.id;

            const got = yield* dns.getDnsRecord(zoneId, id);
            const list = yield* dns.listDnsRecords(zoneId, { type: "A" });
            const updated = yield* dns.updateDnsRecord(zoneId, id, {
              type: "A",
              name,
              content: "192.0.2.2",
              ttl: 1,
            });
            yield* dns.deleteDnsRecord(zoneId, id);

            return yield* HttpServerResponse.json({
              id,
              getName: got.name,
              count: list.result?.length,
              updatedId: updated.id,
              deleted: true,
            });
          }).pipe(
            Effect.catchCause((cause) =>
              HttpServerResponse.json(
                { error: Cause.pretty(cause) },
                { status: 500 },
              ),
            ),
          );
        }

        return HttpServerResponse.text("ok");
      }),
    };
  }).pipe(Effect.provide(Cloudflare.DnsReadWriteLive)),
) {}
