import { describe, expect, it } from "@alchemy.run/test";
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
  it("double-quotes each value and escapes the characters systemd unescapes", () => {
    expect(systemdEnvFile({ B: "it's", A: "a\nb", C: Redacted.make("s"), D: 1, E: 'q"\\$`' })).toBe(
      ['A="a\nb"', 'B="it\'s"', 'C="s"', 'D="1"', 'E="q\\"\\\\\\$\\`"'].join("\n"),
    );
  });

  it("leaves out keys systemd can't hold", () => {
    expect(systemdEnvFile({ "MY.KEY": "x", "K-2": "y", "A B": "z", OK_1: "w" })).toBe('OK_1="w"');
  });
});

describe("containerEnvFile", { tags: ["unit"] }, () => {
  it("lists -e NAME for each key, for docker run to copy from systemd's env", () => {
    expect(containerEnvFile({ B: "b", A: "a\nb", "MY.KEY": "x" })).toBe(
      ['A="a\nb"', 'B="b"', 'ALCHEMY_DOCKER_ENV="-e A -e B"'].join("\n"),
    );
  });
});
