import { describe, expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import {
  collectRedactedSecrets,
  redactionMarker,
  redactJson,
  redactStream,
  redactText,
} from "@/Util/Redaction.ts";

const tags = ["unit", "local"];

describe("collectRedactedSecrets", () => {
  test(
    "collects strings inside redacted values and containers",
    () => {
      expect(collectRedactedSecrets({ token: Redacted.make("s3cr3t") })).toEqual(["s3cr3t"]);
      expect(collectRedactedSecrets(Redacted.make({ token: "s3cr3t" }))).toEqual(["s3cr3t"]);
      expect(
        collectRedactedSecrets(Redacted.make(["s3cr3t", { nested: "another-secret" }])),
      ).toEqual(["s3cr3t", "another-secret"]);
      expect(
        collectRedactedSecrets({ public: "ordinary-text", token: Redacted.make("s3cr3t") }),
      ).toEqual(["s3cr3t"]);
      expect(
        collectRedactedSecrets(
          Redacted.make({
            token: Redacted.make("s3cr3t"),
            nested: { password: "another-secret" },
          }),
        ),
      ).toEqual(["s3cr3t", "another-secret"]);
      expect(collectRedactedSecrets(Redacted.make({ pin: "ab" }))).toEqual(["ab"]);
      expect(collectRedactedSecrets(Redacted.make(123456))).toEqual(["123456"]);
    },
    { tags },
  );

  test(
    "parses a redacted JSON string so its inner values are secrets too",
    () => {
      expect(collectRedactedSecrets(Redacted.make('{"pin":"s3cr3t"}'))).toEqual([
        '{"pin":"s3cr3t"}',
        "s3cr3t",
      ]);
    },
    { tags },
  );
});

describe("redactText", () => {
  test(
    "replaces the raw, base64 and JSON-escaped forms of a secret",
    () => {
      const secret = 'pa"ss';
      const base64 = Buffer.from(secret).toString("base64");
      expect(redactText(`raw ${secret} b64 ${base64} json pa\\"ss`, [secret])).toBe(
        "raw <redacted> b64 <redacted> json <redacted>",
      );
    },
    { tags },
  );

  test(
    "matches long secrets anywhere and short secrets only as whole tokens",
    () => {
      expect(redactText("prefixs3cr3tsuffix", ["s3cr3t"])).toBe("prefix<redacted>suffix");
      expect(redactText("code 14293 says 42", ["42"])).toBe("code 14293 says <redacted>");
    },
    { tags },
  );

  test(
    "replaces the longest secret first when one is a prefix of another",
    () => {
      expect(redactText("value abcdefghij", ["abcd", "abcdefghij"])).toBe("value <redacted>");
    },
    { tags },
  );

  test(
    "uses the caller's marker",
    () => {
      expect(redactText("token s3cr3t", ["s3cr3t"], "[REDACTED]")).toBe("token [REDACTED]");
    },
    { tags },
  );
});

describe("redactJson", () => {
  test(
    "redacts JSON leaf by leaf and falls back to text",
    () => {
      const body = JSON.stringify({
        n: 14293,
        token: "42",
        data: Buffer.from("42").toString("base64"),
        message: 'code 14293 says "42"',
      });
      expect(JSON.parse(redactJson(body, ["42"]))).toEqual({
        n: 14293,
        token: "<redacted>",
        data: "<redacted>",
        message: 'code 14293 says "<redacted>"',
      });
      expect(JSON.parse(redactJson('{"message":"abcdefghij"}', ["abcd", "abcdefghij"]))).toEqual({
        message: "<redacted>",
      });
      expect(redactJson("rendered a v1/s3cr3t name", ["s3cr3t"])).toBe(
        "rendered a v1/<redacted> name",
      );
    },
    { tags },
  );
});

describe("redactStream", () => {
  test(
    "redacts a secret split across chunks, including its base64 form",
    () =>
      Effect.gen(function* () {
        const base64 = Buffer.from("s3cr3t").toString("base64");
        const chunks = ["one s3c", "r3t two ", base64.slice(0, 3), base64.slice(3), " end"];
        const out = yield* Stream.fromIterable(chunks).pipe(
          (stream) => redactStream(stream, ["s3cr3t"]),
          Stream.mkString,
        );
        expect(out).toBe("one <redacted> two <redacted> end");
      }),
    { tags },
  );
});

describe("redactionMarker", () => {
  test(
    "keeps the preferred marker unless a secret appears inside it",
    () => {
      expect(redactionMarker(["s3cr3t"], "[REDACTED]")).toBe("[REDACTED]");
      const marker = redactionMarker(["[REDACTED]"], "[REDACTED]");
      expect(marker).not.toBe("[REDACTED]");
      expect("[REDACTED]".includes(marker)).toBe(false);
    },
    { tags },
  );
});
