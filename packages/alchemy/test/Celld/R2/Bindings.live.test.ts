import { describe, expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";

const url = process.env.CELLD_R2_BINDING_TEST_URL;

// The parent deploys fixtures/worker.ts against its shared real 0.5 node.
describe.skipIf(!url)("Celld 0.5 R2 binding conformance", () => {
  test.effect(
    "native CRUD, conditions, streaming, ranges, multipart and unsupported options",
    () =>
      Effect.gen(function* () {
        const response = yield* HttpClient.get(url!);
        expect(response.status).toBe(200);
        const value = (yield* response.json) as {
          missing: null;
          key: string;
          metadata: unknown;
          contentType: string;
          json: unknown;
          consumed: boolean;
          unmatchedHasBody: boolean;
          refused: null;
          bytes: number[];
          range: number[];
          first: { truncated: boolean; keys: string[] };
          second: { truncated: boolean; keys: string[] };
          unsupported: string;
          granularity: string;
          partEtag: string;
          multipart: string;
          deleted: null;
          remaining: number;
        };
        expect(value.missing).toBeNull();
        expect(value.key).toBe("alchemy-r2-binding/a");
        expect(value.metadata).toEqual({ version: "1" });
        expect(value.contentType).toBe("application/json");
        expect(value.json).toEqual({ hello: "celld" });
        expect(value.consumed).toBe(true);
        expect(value.unmatchedHasBody).toBe(false);
        expect(value.refused).toBeNull();
        expect(value.bytes).toEqual([0, 255, 1]);
        expect(value.range).toEqual([255]);
        expect(value.first).toEqual({
          truncated: true,
          keys: ["alchemy-r2-binding/a"],
        });
        expect(value.second).toEqual({
          truncated: false,
          keys: ["alchemy-r2-binding/b"],
        });
        expect(value.unsupported).toBe("Celld.R2.R2Error");
        expect(value.granularity).toBe("Celld.R2.R2Error");
        expect(value.partEtag).toBe("");
        expect(value.multipart).toBe("multipart");
        expect(value.deleted).toBeNull();
        expect(value.remaining).toBe(0);
      }).pipe(Effect.provide(FetchHttpClient.layer)),
    { timeout: 90000 },
  );
});
