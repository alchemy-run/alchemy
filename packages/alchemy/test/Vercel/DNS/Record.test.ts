import * as Vercel from "@/Vercel";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Vercel.providers() });

const hasVercelCreds = !!process.env.VERCEL_TOKEN;
// Point at a domain you own before running live. The test creates and
// deletes a single TXT record and leaves nothing behind.
const liveDomain = process.env.VERCEL_TEST_DOMAIN;

test.provider.skipIf(!hasVercelCreds || !liveDomain)(
  "Record: create, read, update and delete a TXT record",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const record = yield* Vercel.Record("VercelDnsTestRecord", {
            domain: liveDomain as string,
            name: "alchemy-test-record",
            type: "TXT",
            value: "alchemy-test-value-1",
            ttl: 60,
          });
          return { recordId: record.id, value: record.value, ttl: record.ttl };
        }),
      );
      expect(out.value).toBe("alchemy-test-value-1");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const record = yield* Vercel.Record("VercelDnsTestRecord", {
            domain: liveDomain as string,
            name: "alchemy-test-record",
            type: "TXT",
            value: "alchemy-test-value-2",
            ttl: 60,
          });
          return { recordId: record.id, value: record.value };
        }),
      );
      expect(updated.recordId).toBe(out.recordId);
      expect(updated.value).toBe("alchemy-test-value-2");

      yield* stack.destroy();
    }),
);
