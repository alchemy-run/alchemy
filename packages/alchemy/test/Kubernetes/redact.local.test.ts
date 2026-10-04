import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Kubernetes from "@/Kubernetes";
import { collectRedactedSecrets, scrubSecrets } from "@/Kubernetes/internal/redact.ts";
import { containerEnvValue } from "@/Kubernetes/internal/workload.ts";
import * as Test from "@/Test/Alchemy";
import { unwrapRedacted } from "@/Util/data.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(Kubernetes.providers(), NodeServices.layer),
});

test(
  "collectRedactedSecrets collects strings inside redacted containers",
  Effect.gen(function* () {
    expect(collectRedactedSecrets({ token: Redacted.make("s3cr3t") })).toEqual(["s3cr3t"]);
    expect(collectRedactedSecrets(Redacted.make({ token: "s3cr3t" }))).toEqual(["s3cr3t"]);
    expect(collectRedactedSecrets(Redacted.make(["s3cr3t", { nested: "another-secret" }]))).toEqual(
      ["s3cr3t", "another-secret"],
    );
    expect(
      collectRedactedSecrets({
        public: "ordinary-text",
        token: Redacted.make("s3cr3t"),
      }),
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
    return yield* Effect.void;
  }),
  { tags: ["provider:kubernetes", "local"] },
);

test(
  "scrubSecrets redacts whole values and container env keeps Redacted strings",
  Effect.sync(() => {
    const body = JSON.stringify({
      n: 14293,
      token: "42",
      data: Buffer.from("42").toString("base64"),
      message: 'code 14293 says "42"',
    });
    expect(JSON.parse(scrubSecrets(body, ["42"]))).toEqual({
      n: 14293,
      token: "<redacted>",
      data: "<redacted>",
      message: 'code 14293 says "<redacted>"',
    });
    expect(scrubSecrets("rendered a v1/s3cr3t name", ["s3cr3t"])).toBe(
      "rendered a v1/<redacted> name",
    );
    expect(scrubSecrets("prefixs3cr3tsuffix", ["s3cr3t"])).toBe("prefix<redacted>suffix");
    expect(scrubSecrets("value abcdefghij", ["abcd", "abcdefghij"])).toBe("value <redacted>");
    expect(JSON.parse(scrubSecrets('{"message":"abcdefghij"}', ["abcd", "abcdefghij"]))).toEqual({
      message: "<redacted>",
    });

    const wrapped = containerEnvValue(Redacted.make("s3cr3t"));
    expect(Redacted.isRedacted(wrapped)).toBe(true);
    expect(JSON.stringify(unwrapRedacted({ value: wrapped }))).toBe('{"value":"s3cr3t"}');
    const objectEnv = containerEnvValue({ pin: Redacted.make("s3cr3t") });
    expect(Redacted.isRedacted(objectEnv)).toBe(true);
    expect(collectRedactedSecrets(objectEnv)).toEqual(['{"pin":"s3cr3t"}', "s3cr3t"]);
    expect(containerEnvValue({ pin: "plain" })).toBe('{"pin":"plain"}');
    const pin = containerEnvValue(Redacted.make(123456));
    expect(Redacted.isRedacted(pin)).toBe(true);
    expect(Redacted.isRedacted(pin) && Redacted.value(pin)).toBe("123456");
  }),
  { tags: ["provider:kubernetes", "local"] },
);
