import {
  canonicalZoneName,
  findZoneByName,
  isId,
  matchesZoneHostname,
  resolveZoneId,
  zoneNameCandidates,
} from "@alchemy.run/cloudflare/Zone/lookup";
import { describe, expect, test } from "@alchemy.run/test";
import { Credentials } from "@distilled.cloud/cloudflare/Credentials";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

const zone = (id: string, name: string, accountId: string) => ({
  id,
  account: { id: accountId },
  activatedOn: "",
  createdOn: "",
  developmentMode: 0,
  meta: {},
  modifiedOn: "",
  name,
  nameServers: [],
  originalDnshost: "",
  originalNameServers: [],
  originalRegistrar: "",
  owner: {},
  plan: {},
});

const response = (
  result: ReturnType<typeof zone>[],
  page: number,
  totalPages = 1,
  totalCount = result.length,
) =>
  Response.json({
    success: true,
    errors: [],
    messages: [],
    result,
    result_info: {
      count: result.length,
      page,
      per_page: 100,
      total_count: totalCount,
      total_pages: totalPages,
    },
  });

describe(
  "Cloudflare zone lookup",
  { tags: ["unit", "provider:cloudflare", "provider:cloudflare:zone", "local"] },
  () => {
    const withoutCredentials = <A, E>(
      effect: Effect.Effect<A, E, Credentials | HttpClient.HttpClient>,
    ) =>
      effect.pipe(
        Effect.provideService(
          Credentials,
          Effect.die("explicit zone IDs must not resolve credentials"),
        ),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("explicit zone IDs must not list zones")),
        ),
        Effect.runSync,
      );

    test("zoneNameCandidates walks hostname labels longest-first", () => {
      expect(zoneNameCandidates("app.example.com")).toEqual(["app.example.com", "example.com"]);
      expect(zoneNameCandidates("a.b.c.example.com")).toEqual([
        "a.b.c.example.com",
        "b.c.example.com",
        "c.example.com",
        "example.com",
      ]);
      expect(zoneNameCandidates("example.com")).toEqual(["example.com"]);
    });

    test("canonicalizes names and requires a dot boundary", () => {
      expect(canonicalZoneName("Example.COM...")).toBe("example.com");
      expect(matchesZoneHostname("Example.COM.", "WWW.EXAMPLE.COM.")).toBe(true);
      expect(matchesZoneHostname("example.com", "fooexample.com")).toBe(false);
    });

    test.effect("uses paginated production lookup with account and name filters", () => {
      const requests: URL[] = [];
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          const url = new URL(request.url);
          requests.push(url);
          const page = Number(url.searchParams.get("page"));
          return HttpClientResponse.fromWeb(
            request,
            response(
              page === 1
                ? Array.from({ length: 100 }, (_, index) =>
                    zone(`irrelevant-${index}.net`, `irrelevant-${index}.net`, "account-b"),
                  )
                : [zone("right", "EXAMPLE.COM.", "account-a")],
              page,
              2,
              101,
            ),
          );
        }),
      );
      return findZoneByName({ accountId: "account-a", name: "Example.COM." }).pipe(
        Effect.provideService(
          Credentials,
          Effect.succeed({
            type: "apiToken" as const,
            apiToken: Redacted.make("test-token"),
            apiBaseUrl: "https://api.cloudflare.test",
          }),
        ),
        Effect.provide(Layer.succeed(HttpClient.HttpClient, client)),
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(requests).toHaveLength(2);
            expect(result?.id).toBe("right");
            for (const request of requests) {
              expect(request.searchParams.get("account.id")).toBe("account-a");
              expect(request.searchParams.get("name")).toBe("Example.COM.");
              expect(request.searchParams.get("per_page")).toBe("100");
            }
            expect(requests[0]?.searchParams.get("page")).toBe("1");
            expect(requests[1]?.searchParams.get("page")).toBe("2");
          }),
        ),
      );
    });

    test.effect("preserves first-match behavior for same-account duplicate names", () => {
      const client = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            response(
              [
                zone("first", "EXAMPLE.COM.", "account-a"),
                zone("second", "example.com", "account-a"),
              ],
              1,
            ),
          ),
        ),
      );
      return findZoneByName({ accountId: "account-a", name: "example.com" }).pipe(
        Effect.provideService(
          Credentials,
          Effect.succeed({
            type: "apiToken" as const,
            apiToken: Redacted.make("test-token"),
            apiBaseUrl: "https://api.cloudflare.test",
          }),
        ),
        Effect.provide(Layer.succeed(HttpClient.HttpClient, client)),
        Effect.tap((result) => Effect.sync(() => expect(result?.id).toBe("first"))),
      );
    });

    test.effect("resolves the longest matching suffix through production lookup", () => {
      const names: string[] = [];
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          const url = new URL(request.url);
          const name = url.searchParams.get("name") ?? "";
          names.push(name);
          return HttpClientResponse.fromWeb(
            request,
            response(name === "sub.example.com" ? [zone("sub", name, "account")] : [], 1),
          );
        }),
      );
      return resolveZoneId({
        accountId: "account",
        zone: undefined,
        hostname: "a.sub.example.com",
      }).pipe(
        Effect.provideService(
          Credentials,
          Effect.succeed({
            type: "apiToken" as const,
            apiToken: Redacted.make("test-token"),
            apiBaseUrl: "https://api.cloudflare.test",
          }),
        ),
        Effect.provide(Layer.succeed(HttpClient.HttpClient, client)),
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result).toBe("sub");
            expect(names).toEqual(["a.sub.example.com", "sub.example.com"]);
          }),
        ),
      );
    });

    test.effect("rejects a non-boundary suffix through production lookup", () => {
      const names: string[] = [];
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          const url = new URL(request.url);
          names.push(url.searchParams.get("name") ?? "");
          return HttpClientResponse.fromWeb(request, response([], 1));
        }),
      );
      return resolveZoneId({
        accountId: "account",
        zone: undefined,
        hostname: "www.fooexample.com",
      }).pipe(
        Effect.provideService(
          Credentials,
          Effect.succeed({
            type: "apiToken" as const,
            apiToken: Redacted.make("test-token"),
            apiBaseUrl: "https://api.cloudflare.test",
          }),
        ),
        Effect.provide(Layer.succeed(HttpClient.HttpClient, client)),
        Effect.tapError((error) =>
          Effect.sync(() => {
            expect(error._tag).toBe("ZoneLookupInvalidProps");
            expect(names).toEqual(["www.fooexample.com", "fooexample.com"]);
            expect(names).not.toContain("example.com");
          }),
        ),
        Effect.flip,
      );
    });

    test("resolveZoneId returns an explicit zone id without listing zones", () => {
      const zoneId = "0123456789abcdef0123456789abcdef";
      expect(isId(zoneId)).toBe(true);
      expect(
        withoutCredentials(
          resolveZoneId({ accountId: "account", zone: zoneId, hostname: "app.example.com" }),
        ),
      ).toEqual(zoneId);
      expect(
        withoutCredentials(
          resolveZoneId({
            accountId: "account",
            zone: { zoneId, name: "example.com" },
            hostname: "app.example.com",
          }),
        ),
      ).toEqual(zoneId);
    });
  },
);
