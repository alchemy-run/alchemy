import * as AWS from "@/AWS";
import { Certificate } from "@/AWS/ACM/Certificate.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Canonical `list()` test (AWS account/region-scoped collection): request a
// real ACM certificate (no DNS validation, stays PENDING_VALIDATION), resolve
// the provider from context via the typed `findProvider` helper, call `list()`,
// and assert the deployed certificate ARN appears in the exhaustively-paginated
// result. A PENDING certificate is fully enumerable and deletable.
test.provider(
  "list enumerates the deployed certificate",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const cert = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Certificate("ListCertificate", {
            domainName: "alchemy-acm-list-test.example.com",
          });
        }),
      );

      expect(cert.certificateArn).toBeDefined();

      const provider = yield* Provider.findProvider(Certificate);
      // ACM `ListCertificates` is eventually consistent — a freshly requested
      // certificate can take a few seconds to surface in the paginated
      // listing. Poll until our ARN appears, bounded.
      const all = yield* Effect.gen(function* () {
        const result = yield* provider.list();
        if (!result.some((c) => c.certificateArn === cert.certificateArn)) {
          return yield* Effect.fail(new CertificateNotListed());
        }
        return result;
      }).pipe(
        Effect.retry({
          while: (e) => e._tag === "CertificateNotListed",
          schedule: Schedule.fixed("3 seconds").pipe(
            Schedule.both(Schedule.recurs(20)),
          ),
        }),
      );

      expect(all.some((c) => c.certificateArn === cert.certificateArn)).toBe(
        true,
      );

      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);

class CertificateNotListed extends Data.TaggedError("CertificateNotListed") {}
