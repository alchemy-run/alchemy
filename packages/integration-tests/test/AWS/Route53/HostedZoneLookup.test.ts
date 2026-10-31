import {
  AmbiguousHostedZone,
  findPublicHostedZoneIdFrom,
  hostedZoneNameCandidates,
  normalizeHostedZoneName,
} from "@alchemy.run/aws/Route53/HostedZoneLookup";
import { expect, test } from "@alchemy.run/test";
import * as route53 from "@distilled.cloud/aws/route-53";
import * as Effect from "effect/Effect";

const zone = (Name: string, Id: string, PrivateZone = false) => ({
  Name,
  Id,
  CallerReference: "test",
  Config: { PrivateZone },
});

const page = (
  HostedZones: route53.HostedZone[],
  options: Partial<route53.ListHostedZonesByNameResponse> = {},
): route53.ListHostedZonesByNameResponse => ({
  HostedZones,
  IsTruncated: false,
  MaxItems: 100,
  ...options,
});

test("normalizes names and generates longest dot-boundary candidates", () => {
  expect(normalizeHostedZoneName("Example.COM...")).toBe("example.com.");
  expect(hostedZoneNameCandidates("*.WWW.Example.COM.")).toEqual([
    "*.www.example.com.",
    "www.example.com.",
    "example.com.",
  ]);
});

test.effect("selects the longest public zone and excludes private zones", () =>
  Effect.gen(function* () {
    const result = yield* findPublicHostedZoneIdFrom("www.example.com.", (request) =>
      Effect.succeed(
        page(
          request.DNSName === "www.example.com."
            ? [zone("WWW.Example.COM.", "/hostedzone/Z-WWW", true)]
            : request.DNSName === "example.com."
              ? [zone("Example.COM.", "/hostedzone/Z-EXAMPLE")]
              : [],
        ),
      ),
    );
    expect(result).toBe("Z-EXAMPLE");
  }),
);

test.effect("keeps scanning when a private zone precedes a public zone", () =>
  Effect.gen(function* () {
    const requests: route53.ListHostedZonesByNameRequest[] = [];
    const responses = [
      page([zone("example.com.", "/hostedzone/Z-PRIVATE", true)], {
        IsTruncated: true,
        NextDNSName: "example.com.",
        NextHostedZoneId: "/hostedzone/Z-PRIVATE",
      }),
      page([zone("EXAMPLE.COM", "/hostedzone/Z-PUBLIC")]),
    ];
    const result = yield* findPublicHostedZoneIdFrom("example.com", (request) => {
      requests.push(request);
      return Effect.succeed(responses.shift() ?? page([]));
    });
    expect(requests).toEqual([
      { DNSName: "example.com.", MaxItems: 100 },
      {
        DNSName: "example.com.",
        HostedZoneId: "/hostedzone/Z-PRIVATE",
        MaxItems: 100,
      },
    ]);
    expect(result).toBe("Z-PUBLIC");
  }),
);

test.effect("returns no zone for a no-match or private-only lookup", () =>
  Effect.gen(function* () {
    const noMatch = yield* findPublicHostedZoneIdFrom("missing.example", () =>
      Effect.succeed(page([])),
    );
    const privateOnly = yield* findPublicHostedZoneIdFrom("private.example", () =>
      Effect.succeed(page([zone("private.example.", "/hostedzone/Z-PRIVATE", true)])),
    );
    expect(noMatch).toBeUndefined();
    expect(privateOnly).toBeUndefined();
  }),
);

test.effect("rejects a duplicate public zone found on a later page", () =>
  Effect.gen(function* () {
    const requests: route53.ListHostedZonesByNameRequest[] = [];
    const responses = [
      page([zone("www.example.com.", "/hostedzone/Z-ONE")], {
        IsTruncated: true,
        NextDNSName: "www.example.com.",
        NextHostedZoneId: "/hostedzone/Z-ONE",
      }),
      page([zone("WWW.EXAMPLE.COM", "/hostedzone/Z-TWO")]),
    ];
    const error = yield* findPublicHostedZoneIdFrom("www.example.com", (request) => {
      requests.push(request);
      return Effect.succeed(responses.shift() ?? page([]));
    }).pipe(Effect.flip);
    expect(error).toBeInstanceOf(AmbiguousHostedZone);
    expect(requests[1]).toEqual({
      DNSName: "www.example.com.",
      HostedZoneId: "/hostedzone/Z-ONE",
      MaxItems: 100,
    });
  }),
);
