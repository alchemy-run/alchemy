import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Vitest";
import { Region as AwsRegion } from "@distilled.cloud/aws/Region";
import * as route53domains from "@distilled.cloud/aws/route-53-domains";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { describe } from "vitest";

import Route53DomainsTestFunctionLive, {
  Route53DomainsTestFunction,
} from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "Route53DomainsBindings");

// The Route 53 Domains API is global and only served from us-east-1 — pin
// the region for out-of-band probes made directly from the test process.
const withRoute53DomainsRegion = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(AwsRegion, Effect.succeed("us-east-1")));

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy under parallel-suite load.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// Retry transient 5xx only; a genuine 4xx/assertion failure surfaces
// immediately.
const send = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClient.execute(request).pipe(
    Effect.flatMap((response) =>
      response.status >= 500
        ? response.text.pipe(
            Effect.flatMap((body) =>
              Effect.fail(
                new TransientUpstream({ status: response.status, body }),
              ),
            ),
          )
        : Effect.succeed(response),
    ),
    Effect.retry({
      while: (e) => e._tag === "TransientUpstream",
      schedule: Schedule.max([
        Schedule.exponential("1 second"),
        Schedule.recurs(5),
      ]),
    }),
  );

// Ungated probes against the real API (read-only, free). This suite NEVER
// calls registerDomain — registration costs money and is irreversible.
test.provider(
  "checkDomainAvailability succeeds for a deterministic unregistered name",
  (_stack) =>
    Effect.gen(function* () {
      const result = yield* withRoute53DomainsRegion(
        route53domains.checkDomainAvailability({
          // Deterministic probe name — read-only availability check, no
          // registration ever happens in this suite.
          DomainName: "alchemy-effect-r53d-probe-a32892.com",
        }),
      );
      // The exact verdict (AVAILABLE vs PENDING) is registry-dependent; the
      // probe proves auth + the us-east-1 pin + response decoding.
      expect(result.Availability).toBeDefined();
    }),
  { timeout: 60_000 },
);

test.provider(
  "getDomainDetail on a domain not in the account fails with typed DomainNotFound",
  (_stack) =>
    Effect.gen(function* () {
      // example.com is never registered in the test account. The overloaded
      // InvalidInput ("Domain example.com not found in account.") is
      // specialized to DomainNotFound by the distilled patch.
      const detail = yield* withRoute53DomainsRegion(
        route53domains.getDomainDetail({ DomainName: "example.com" }),
      ).pipe(
        Effect.catchTag("DomainNotFound", (error) =>
          Effect.succeed(error._tag),
        ),
      );
      expect(detail).toBe("DomainNotFound");
    }),
  { timeout: 60_000 },
);

test.provider(
  "listDomains succeeds for the account",
  (_stack) =>
    Effect.gen(function* () {
      const result = yield* withRoute53DomainsRegion(
        route53domains.listDomains({ MaxItems: 100 }),
      );
      // The testing account owns no domains — the call succeeding with a
      // (possibly empty) list proves auth and response decoding.
      expect(Array.isArray(result.Domains ?? [])).toBe(true);
    }),
  { timeout: 60_000 },
);

describe("Route53Domains Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "Route53Domains test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("Route53Domains test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* Route53DomainsTestFunction;
        }).pipe(Effect.provide(Route53DomainsTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");
      const readinessUrl = `${baseUrl}/ping`;

      yield* Effect.logInfo(
        `Route53Domains test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `Route53Domains test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 120_000 });

  describe("CheckDomainAvailability", () => {
    test.provider(
      "returns an availability verdict from inside the Lambda",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.get(`${baseUrl}/availability`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            availability: string | undefined;
          };

          expect(response.availability).toBeDefined();
        }),
      { timeout: 120_000 },
    );
  });

  describe("ListDomains", () => {
    test.provider(
      "lists the account's registered domains from inside the Lambda",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.get(`${baseUrl}/domains`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            count: number;
            names: string[];
          };

          expect(response.count).toBeGreaterThanOrEqual(0);
          expect(Array.isArray(response.names)).toBe(true);
        }),
      { timeout: 120_000 },
    );
  });

  describe("GetDomainDetail", () => {
    test.provider(
      "reaches the API from inside the Lambda and gets a typed domain error",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.get(`${baseUrl}/detail`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            ok: boolean;
            errorTag?: string;
          };

          // The call must reach the API (proving the IAM grant and the
          // us-east-1 pin) and fail with a domain-level error — never
          // AccessDenied. The deployed bundle resolves distilled from the
          // built lib/, so until the coordinator rebuilds it the runtime
          // still maps this error to the base InvalidInput instead of the
          // patched DomainNotFound specialization (the strict typed
          // assertion is the out-of-band probe above).
          expect(response.ok).toBe(false);
          expect(["DomainNotFound", "InvalidInput"]).toContain(
            response.errorTag,
          );
        }),
      { timeout: 120_000 },
    );
  });
});
