import { constants, createDecipheriv, generateKeyPairSync, privateDecrypt } from "node:crypto";
import {
  installScript,
  prepareScript,
  publicKeyInOutput,
  removeScript,
  renderEnvFile,
  sealEnv,
} from "@alchemy.run/stackit/internal/commandHost";
import { hostEnvVariable } from "@alchemy.run/stackit/internal/serverHost";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

/** STACKIT's documented cap on a script. */
const SCRIPT_LIMIT = 10_000;

describe("Stackit commandHost", () => {
  describe("renderEnvFile", () => {
    it("sorts names and keeps values literal for systemd", () => {
      expect(
        renderEnvFile({
          B: `quote " slash \\ tick \` dollar $HOME`,
          A: "line one\nline two",
        }),
      ).toBe(`A="line one\nline two"\nB="quote \\" slash \\\\ tick \\\` dollar \\$HOME"\n`);
    });
  });

  describe("hostEnvVariable", () => {
    it("writes PORT raw, so core's Config.Number can parse it", () => {
      // A number-shaped string packs to one in quotes, which is what crash-looped the program.
      expect(hostEnvVariable("OTHER", "3000", false)).toBe(`"3000"`);
      expect(renderEnvFile({ PORT: hostEnvVariable("PORT", "3000", false) })).toBe(`PORT="3000"\n`);
    });
  });

  describe("sealEnv", () => {
    it.effect("seals to the public key, with the AES key wrapped as hex", () =>
      Effect.gen(function* () {
        const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
        const envFile = `SECRET="${"s".repeat(4000)}"\n`;
        const { files, iv } = yield* sealEnv({
          resourceName: "Test",
          envFile: Redacted.make(envFile),
          publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
        });
        const [sealed, wrapped] = files;
        const aes = privateDecrypt(
          { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
          wrapped!.content,
        ).toString("utf8");
        expect(aes).toMatch(/^[0-9a-f]{64}$/);
        const decipher = createDecipheriv(
          "aes-256-cbc",
          Buffer.from(aes, "hex"),
          Buffer.from(iv, "hex"),
        );
        const opened = Buffer.concat([decipher.update(sealed!.content), decipher.final()]);
        expect(opened.toString("utf8")).toBe(envFile);
        expect(Buffer.from(sealed!.content).toString("utf8")).not.toContain("sssss");
      }),
    );

    it.effect("fails with a typed error that doesn't quote the env, on a bad key", () =>
      Effect.gen(function* () {
        const error = yield* sealEnv({
          resourceName: "Test",
          envFile: Redacted.make(`SECRET="do-not-print"`),
          publicKey: "not a key",
        }).pipe(Effect.flip);
        expect(error._tag).toBe("Stackit.IaaS.ServerKeyUnusable");
        expect(error.message).not.toContain("do-not-print");
      }),
    );
  });

  describe("publicKeyInOutput", () => {
    it("finds the key among other output, and reports a missing one", () => {
      const key = "-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----";
      expect(publicKeyInOutput(`noise\n${key}\nmore`)).toBe(key);
      expect(publicKeyInOutput("no key here")).toBeUndefined();
    });
  });

  describe("scripts", () => {
    const unitName = "a".repeat(64);
    const install = (probePort: number | undefined) =>
      installScript({
        unitName,
        url: `https://object.storage.eu01.onstackit.cloud/bucket/key?${"x".repeat(1500)}`,
        sha256: "0".repeat(64),
        iv: "1".repeat(32),
        probePort,
      });

    it("fit STACKIT's limit, with a long unit name and URL", () => {
      for (const script of [prepareScript(unitName), install(3000), removeScript(unitName)]) {
        expect(script.length).toBeLessThan(SCRIPT_LIMIT);
      }
    });

    it("install bun under a bounded lock, with the check repeated inside it", () => {
      const prepare = prepareScript(unitName);
      expect(prepare).toContain("flock -w 300 /opt/alchemy-bun.lock");
      expect(prepare).toContain("[ -x /opt/alchemy-bun/bin/bun ] ||");
    });

    it("run the program from a directory that outlives each release", () => {
      const script = install(3000);
      expect(script).toContain(`StateDirectory=${unitName}`);
      expect(script).toContain(`WorkingDirectory=/var/lib/${unitName}`);
      expect(script).toContain(
        `ExecStart=/opt/alchemy-bun/bin/bun /opt/${unitName}/current/index.mjs`,
      );
      expect(removeScript(unitName)).toContain(`/var/lib/${unitName}`);
    });

    it("hold readiness for longer than a program takes to fail after starting", () => {
      expect(install(undefined)).toContain(`"$healthy" -ge 8`);
    });

    it("probe the port only when one is set", () => {
      expect(install(3000)).toContain("http://127.0.0.1:3000/");
      expect(install(undefined)).not.toContain("127.0.0.1");
    });
  });
});
