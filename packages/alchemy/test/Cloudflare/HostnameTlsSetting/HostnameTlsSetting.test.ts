import * as Cloudflare from "@/Cloudflare";
import { Unowned } from "@/AdoptPolicy";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as hostnames from "@distilled.cloud/cloudflare/hostnames";
import { HostnameTlsSettingProvider } from "@/Cloudflare/HostnameTlsSetting/HostnameTlsSetting";
import { noopSession } from "@/Report";
import {
  Credentials,
  apiTokenCredentials,
} from "@distilled.cloud/cloudflare/Credentials";
import { expect, it } from "alchemy-test";
import * as Result from "effect/Result";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

it.live(
  "migration: TLS observation uses bare-array LIST and preserves missing and no-op behavior",
  () =>
    Effect.gen(function* () {
      let exists = false;
      const methods: string[] = [];
      const news = {
        zoneId: "zone-id",
        settingId: "min_tls_version" as const,
        hostname: "tls.example.com",
        value: "1.2" as const,
      };
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          methods.push(request.method);
          const collection =
            "https://api.cloudflare.com/client/v4/zones/zone-id/hostnames/settings/min_tls_version";
          expect(request.url).toBe(
            request.method === "GET"
              ? collection
              : `${collection}/${news.hostname}`,
          );
          if (request.method === "PUT") exists = true;
          if (request.method === "DELETE") exists = false;
          const setting = {
            hostname: news.hostname,
            value: news.value,
            status: "active",
          };
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              success: true,
              errors: [],
              messages: [],
              result:
                request.method === "GET" ? (exists ? [setting] : []) : setting,
            }),
          );
        }),
      );
      yield* Effect.gen(function* () {
        const provider = yield* Provider.findProvider(
          Cloudflare.HostnameTlsSetting.HostnameTlsSetting,
        );
        const context = {
          id: "Tls",
          fqn: "Tls",
          instanceId: "migration",
          session: { ...noopSession, note: () => Effect.void },
          bindings: [],
        };
        const missing = yield* provider.read!({
          ...context,
          olds: news,
          output: undefined,
        });
        expect(missing).toBeUndefined();
        const created = yield* provider.reconcile({
          ...context,
          news,
          olds: undefined,
          output: undefined,
        });
        expect(created.value).toBe("1.2");
        const unowned = yield* provider.read!({
          ...context,
          olds: news,
          output: undefined,
        });
        expect(Unowned.is(unowned)).toBe(true);
        const adopted = yield* provider.reconcile({
          ...context,
          news,
          olds: undefined,
          output: created,
        });
        expect(adopted).toEqual(created);
        exists = false;
        const recreated = yield* provider.reconcile({
          ...context,
          news,
          olds: news,
          output: created,
        });
        expect(recreated.value).toBe("1.2");
        yield* provider.delete({ ...context, olds: news, output: created });
        yield* provider.delete({ ...context, olds: news, output: created });
        expect(methods).toEqual([
          "GET",
          "GET",
          "PUT",
          "GET",
          "GET",
          "GET",
          "PUT",
          "GET",
          "DELETE",
          "GET",
        ]);
      }).pipe(
        Effect.provide(HostnameTlsSettingProvider()),
        Effect.provideService(
          CloudflareEnvironment,
          Effect.succeed({
            type: "apiToken",
            apiToken: Redacted.make("test-token"),
            accountId: "account-id",
            source: { type: "env" },
          }),
        ),
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provideService(
          Credentials,
          Effect.succeed(apiTokenCredentials({ apiToken: "test-token" })),
        ),
      );
    }),
);

it.live(
  "migration: TLS enumeration maps bare arrays and skips typed entitlement errors",
  () =>
    Effect.gen(function* () {
      const paths: string[] = [];
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          paths.push(request.url);
          const response = (
            result: unknown,
            status = 200,
            errors: { code: number; message: string }[] = [],
          ) =>
            HttpClientResponse.fromWeb(
              request,
              Response.json(
                {
                  success: status === 200,
                  result,
                  errors,
                  messages: [],
                  result_info: {
                    page: 1,
                    per_page: 20,
                    total_pages: 1,
                    count: 1,
                    total_count: 1,
                  },
                },
                { status },
              ),
            );
          if (new URL(request.url).pathname.endsWith("/zones"))
            return response([
              {
                id: "zone-id",
                name: "example.com",
                account: { id: "account-id" },
                activated_on: "2026-01-01T00:00:00Z",
                created_on: "2026-01-01T00:00:00Z",
                modified_on: "2026-01-01T00:00:00Z",
                development_mode: 0,
                meta: {},
                name_servers: [],
                original_dnshost: "",
                original_name_servers: [],
                original_registrar: "",
                owner: {},
                plan: {},
              },
            ]);
          if (new URL(request.url).pathname.endsWith("/ciphers"))
            return response([
              { hostname: "tls.example.com", value: ["AES128-GCM-SHA256"] },
              { hostname: null },
            ]);
          if (new URL(request.url).pathname.endsWith("/min_tls_version"))
            return response(null, 403, [
              {
                code: 1450,
                message: "Advanced Certificate Manager is required",
              },
            ]);
          return response(null, 403, [{ code: 0, message: "Forbidden" }]);
        }),
      );
      yield* Effect.gen(function* () {
        const provider = yield* Provider.findProvider(
          Cloudflare.HostnameTlsSetting.HostnameTlsSetting,
        );
        const settings = yield* provider.list();
        expect(settings).toHaveLength(1);
        expect(settings[0]?.hostname).toBe("tls.example.com");
        expect(settings[0]?.settingId).toBe("ciphers");
        expect(settings[0]?.value).toEqual(["AES128-GCM-SHA256"]);
        expect(
          paths.filter((path) => path.includes("/hostnames/settings/")),
        ).toHaveLength(3);
      }).pipe(
        Effect.provide(HostnameTlsSettingProvider()),
        Effect.provideService(
          CloudflareEnvironment,
          Effect.succeed({
            type: "apiToken",
            apiToken: Redacted.make("test-token"),
            accountId: "account-id",
            source: { type: "env" },
          }),
        ),
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provideService(
          Credentials,
          Effect.succeed(apiTokenCredentials({ apiToken: "test-token" })),
        ),
      );
    }),
);

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const zoneName =
  process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

// Per-hostname TLS settings are gated behind Advanced Certificate Manager
// (or Cloudflare for SaaS) — on the standard testing zone every PUT/DELETE
// fails with Cloudflare code 1450, surfaced as the typed
// `AdvancedCertificateManagerRequired` error. The full lifecycle test below
// is gated behind an entitled zone + hostname supplied via env.
const acmZoneId = process.env.CLOUDFLARE_TEST_ACM_ZONE_ID;
const acmHostname = process.env.CLOUDFLARE_TEST_ACM_HOSTNAME;

const resolveZoneId = Effect.gen(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const zone = yield* findZoneByName({ accountId, name: zoneName });
  if (!zone) {
    return yield* Effect.die(
      new Error(`zone "${zoneName}" not found in account`),
    );
  }
  return zone.id;
});

// Freshly-minted scoped tokens propagate eventually-consistently across
// Cloudflare's edge — ride out intermittent 403 blips on the test's
// out-of-band calls by retrying the typed `Forbidden` error.
const forbiddenRetrySchedule = Schedule.spaced("1 second");

const findSetting = (zoneId: string, settingId: string, hostname: string) =>
  hostnames.listSettingsTls({ zoneId, settingId }).pipe(
    Effect.map((settings) =>
      settings.find((entry) => entry.hostname === hostname),
    ),
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

test.provider(
  "lists overrides and surfaces the typed AdvancedCertificateManagerRequired error on unentitled zones",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();

      // LIST may also be entitlement-gated on an unentitled zone.
      const list = yield* hostnames
        .listSettingsTls({ zoneId, settingId: "min_tls_version" })
        .pipe(
          Effect.retry({
            while: (e) => e._tag === "Forbidden",
            schedule: forbiddenRetrySchedule,
            times: 8,
          }),
          Effect.catchTag("AdvancedCertificateManagerRequired", (error) => {
            expect(error.code).toBe(1450);
            return Effect.succeed([]);
          }),
        );
      expect(Array.isArray(list)).toBe(true);

      // The standard testing zone lacks the ACM entitlement — a write must
      // fail with the typed entitlement tag (Cloudflare code 1450).
      const hostname = `alchemy-htls-gate.${zoneName}`;
      const original = list.find((setting) => setting.hostname === hostname);
      const result = yield* hostnames
        .putSettingTls({
          zoneId,
          settingId: "min_tls_version",
          hostname,
          value: "1.2",
        })
        .pipe(
          Effect.retry({
            while: (e) => e._tag === "Forbidden",
            schedule: forbiddenRetrySchedule,
            times: 8,
          }),
          Effect.result,
        );
      // Preserve the pre-probe override if the zone gained entitlement.
      if (Result.isSuccess(result)) {
        if (original?.value != null) {
          yield* hostnames.putSettingTls({
            zoneId,
            settingId: "min_tls_version",
            hostname,
            value: original.value,
          });
        } else {
          yield* hostnames.deleteSettingTls({
            zoneId,
            settingId: "min_tls_version",
            hostname,
          });
        }
      } else {
        expect(result.failure._tag).toEqual(
          "AdvancedCertificateManagerRequired",
        );
      }

      yield* stack.destroy();
    }).pipe(logLevel),
);

// Canonical `list()` test (zone-scoped collection): there is no account-wide
// API for per-hostname overrides, so `list()` enumerates every zone via
// `listAllZones` and reads each of the three TLS settings' bare arrays.
// The standing test zone has no ACM entitlement and therefore
// no overrides, so the well-typed result is normally empty; when an entitled
// zone + hostname is supplied via env we deploy one and assert its presence.
test.provider(
  "list enumerates per-hostname TLS overrides",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      if (acmZoneId && acmHostname) {
        yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.HostnameTlsSetting.HostnameTlsSetting(
              "ListMinTls",
              {
                zoneId: acmZoneId,
                settingId: "min_tls_version",
                hostname: acmHostname,
                value: "1.2",
              },
            );
          }),
        );
      }

      const provider = yield* Provider.findProvider(
        Cloudflare.HostnameTlsSetting.HostnameTlsSetting,
      );
      const all = yield* provider.list();

      // Always a well-typed array (possibly empty on an unentitled account).
      expect(Array.isArray(all)).toBe(true);

      if (acmZoneId && acmHostname) {
        expect(
          all.some(
            (s) =>
              s.zoneId === acmZoneId &&
              s.settingId === "min_tls_version" &&
              s.hostname === acmHostname,
          ),
        ).toBe(true);
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!acmZoneId || !acmHostname)(
  "create, update in place, and destroy a min_tls_version override",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = acmZoneId!;
      const hostname = acmHostname!;

      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.HostnameTlsSetting.HostnameTlsSetting(
            "MinTls",
            {
              zoneId,
              settingId: "min_tls_version",
              hostname,
              value: "1.2",
            },
          );
        }),
      );

      expect(created.zoneId).toEqual(zoneId);
      expect(created.settingId).toEqual("min_tls_version");
      expect(created.hostname).toEqual(hostname);
      expect(created.value).toEqual("1.2");

      // Out-of-band verification via the distilled API.
      const live = yield* findSetting(zoneId, "min_tls_version", hostname);
      expect(live).toBeDefined();
      expect(live!.value).toEqual("1.2");

      // Update in place — PUT upserts the same (settingId, hostname) pair.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.HostnameTlsSetting.HostnameTlsSetting(
            "MinTls",
            {
              zoneId,
              settingId: "min_tls_version",
              hostname,
              value: "1.3",
            },
          );
        }),
      );
      expect(updated.hostname).toEqual(hostname);
      expect(updated.value).toEqual("1.3");

      const liveUpdated = yield* findSetting(
        zoneId,
        "min_tls_version",
        hostname,
      );
      expect(liveUpdated!.value).toEqual("1.3");

      yield* stack.destroy();

      // Removal is eventually consistent — poll the list (bounded) until
      // the override disappears and the hostname reverts to zone defaults.
      const gone = yield* findSetting(zoneId, "min_tls_version", hostname).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("3 seconds"),
          until: (entry) => entry === undefined,
          times: 10,
        }),
      );
      expect(gone).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
