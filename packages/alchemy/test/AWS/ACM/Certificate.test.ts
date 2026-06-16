import * as AWS from "@/AWS";
import { Certificate } from "@/AWS/ACM/Certificate.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

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
      const all = yield* provider.list();

      expect(all.some((c) => c.certificateArn === cert.certificateArn)).toBe(
        true,
      );

      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);
