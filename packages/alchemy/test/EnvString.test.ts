import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { envString, envStrings, packEnvValue } from "@/RuntimeContext.ts";
import { containerEnvFile, systemdEnvFile } from "@/Util/envFile.ts";

describe("envString", { tags: ["unit"] }, () => {
  it("keeps strings verbatim, the empty string and JSON-looking ones included", () => {
    for (const value of ["hello", "", "it's", "a\nb", "12345678901.12345678901234", "false"]) {
      expect(envString(value)).toBe(value);
    }
  });

  it("unwraps Redacted values", () => {
    expect(envString(Redacted.make("s3cret"))).toBe("s3cret");
    expect(envString(Redacted.make("123456"))).toBe("123456");
    expect(envString(Redacted.make({ k: 1 }))).toBe('{"k":1}');
  });

  it("writes everything else as JSON", () => {
    expect(envString(3000)).toBe("3000");
    expect(envString(true)).toBe("true");
    expect(envString({ region: "eu" })).toBe('{"region":"eu"}');
    expect(envString(["a", "b"])).toBe('["a","b"]');
  });

  it("treats undefined and null as unset", () => {
    expect(envString(undefined)).toBeUndefined();
    expect(envString(null)).toBeUndefined();
    expect(envStrings({ A: "a", B: undefined, C: null, D: "" })).toEqual({ A: "a", D: "" });
  });

  it("passes a value the runtime context packed through unchanged", () => {
    const packed = packEnvValue(Redacted.make("s3cret"));
    expect(envString(packed)).toBe(packed);
  });
});

describe("systemdEnvFile", { tags: ["unit"] }, () => {
  it.effect("double-quotes each value and escapes the characters systemd unescapes", () =>
    Effect.gen(function* () {
      expect(
        yield* systemdEnvFile({ B: "it's", A: "a\nb", C: Redacted.make("s"), D: 1, E: 'q"\\$`' }),
      ).toBe(['A="a\nb"', 'B="it\'s"', 'C="s"', 'D="1"', 'E="q\\"\\\\\\$\\`"'].join("\n"));
    }),
  );

  it.effect("fails on a key systemd can't hold instead of dropping it", () =>
    Effect.gen(function* () {
      const error = yield* systemdEnvFile({ "discovery.type": "single-node" }).pipe(Effect.flip);
      expect(error._tag).toBe("InvalidEnvKey");
      expect(error.key).toBe("discovery.type");
    }),
  );
});

describe("containerEnvFile", { tags: ["unit"] }, () => {
  it.effect("lists -e NAME for each key, for docker run to copy from systemd's env", () =>
    Effect.gen(function* () {
      expect(yield* containerEnvFile({ B: "b", A: "a\nb" })).toBe(
        ['A="a\nb"', 'B="b"', 'ALCHEMY_DOCKER_ENV="-e A -e B"'].join("\n"),
      );
    }),
  );

  it.effect("reserves the key it lists the -e arguments in", () =>
    Effect.gen(function* () {
      const error = yield* containerEnvFile({ ALCHEMY_DOCKER_ENV: "x" }).pipe(Effect.flip);
      expect(error.key).toBe("ALCHEMY_DOCKER_ENV");
    }),
  );
});
