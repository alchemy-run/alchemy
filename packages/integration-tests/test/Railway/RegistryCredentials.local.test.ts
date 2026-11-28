import { registryCredentialsWrite } from "@alchemy.run/railway/ServiceProvider";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const credentials = { username: "octocat", password: Redacted.make("ghp_first") };

describe(
  "Railway.Service registryCredentials",
  { tags: ["unit", "provider:railway", "local"] },
  () => {
    it.effect("writes nothing and records no fingerprint without the prop", () =>
      Effect.gen(function* () {
        expect(yield* registryCredentialsWrite(undefined, undefined)).toEqual({
          hash: undefined,
          write: undefined,
        });
        expect(yield* registryCredentialsWrite(undefined, "recorded")).toEqual({
          hash: undefined,
          write: undefined,
        });
      }),
    );

    it.effect("writes the plain credentials when none were recorded (create, adoption)", () =>
      Effect.gen(function* () {
        const { hash, write } = yield* registryCredentialsWrite(credentials, undefined);
        expect(write).toEqual({ username: "octocat", password: "ghp_first" });
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
        expect(hash).not.toContain("ghp_first");
      }),
    );

    it.effect("leaves unchanged credentials alone", () =>
      Effect.gen(function* () {
        const first = yield* registryCredentialsWrite(credentials, undefined);
        const again = yield* registryCredentialsWrite(
          { username: "octocat", password: "ghp_first" },
          first.hash,
        );
        expect(again).toEqual({ hash: first.hash, write: undefined });
      }),
    );

    it.effect("writes again when the password or the username changes", () =>
      Effect.gen(function* () {
        const first = yield* registryCredentialsWrite(credentials, undefined);
        const rotated = yield* registryCredentialsWrite(
          { username: "octocat", password: Redacted.make("ghp_second") },
          first.hash,
        );
        expect(rotated.write).toEqual({ username: "octocat", password: "ghp_second" });
        expect(rotated.hash).not.toBe(first.hash);
        const renamed = yield* registryCredentialsWrite(
          { username: "hubot", password: Redacted.make("ghp_first") },
          first.hash,
        );
        expect(renamed.write).toEqual({ username: "hubot", password: "ghp_first" });
        expect(renamed.hash).not.toBe(first.hash);
      }),
    );

    it.effect("keeps the username and password apart in the fingerprint", () =>
      Effect.gen(function* () {
        const a = yield* registryCredentialsWrite({ username: "a\nb", password: "c" }, undefined);
        const b = yield* registryCredentialsWrite({ username: "a", password: "b\nc" }, undefined);
        expect(a.hash).not.toBe(b.hash);
      }),
    );
  },
);
