import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { dockerEnvFile, systemdEnvFile } from "@/EnvFile.ts";
import { envString, envStrings, packEnvValue } from "@/RuntimeContext.ts";

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
  it("double-quotes each value and escapes the characters systemd unescapes", () => {
    expect(systemdEnvFile({ B: "it's", A: "a\nb", C: Redacted.make("s"), D: 1, E: 'q"\\$`' })).toBe(
      ['A="a\nb"', 'B="it\'s"', 'C="s"', 'D="1"', 'E="q\\"\\\\\\$\\`"'].join("\n"),
    );
  });
});

describe("dockerEnvFile", { tags: ["unit"] }, () => {
  it.effect("writes NAME=value lines with values unwrapped", () =>
    Effect.gen(function* () {
      expect(yield* dockerEnvFile({ B: "it's", A: Redacted.make("s"), C: { k: 1 } })).toBe(
        ["A=s", "B=it's", 'C={"k":1}'].join("\n"),
      );
    }),
  );

  it.effect("fails on a value with a newline instead of changing it", () =>
    Effect.gen(function* () {
      const error = yield* dockerEnvFile({ PEM: "a\nb" }).pipe(Effect.flip);
      expect(error._tag).toBe("MultilineEnvValue");
      expect(error.key).toBe("PEM");
    }),
  );
});
