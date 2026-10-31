import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { DEV_TRUST_ENV, trustedCertificates } from "../src/trust.ts";

// The reader splits text; it never parses a certificate, so the bodies are
// arbitrary base64.
const certificate = (body: string, eol = "\n") =>
  ["-----BEGIN CERTIFICATE-----", body, "-----END CERTIFICATE-----"].join(eol) + eol;

const ONE = certificate("T05F");
const TWO = certificate("VFdP");
const THREE = certificate("VEhSRUU=");

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "alchemy-trust-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const write = (name: string, contents: string) => {
  const file = join(dir, name);
  writeFileSync(file, contents);
  return file;
};

describe("trustedCertificates", () => {
  it("reads the caller's file and every contributed file", () => {
    const caller = write("caller.pem", ONE);
    const first = write("first.pem", TWO);
    const second = write("second.pem", THREE);
    expect(
      trustedCertificates({
        NODE_EXTRA_CA_CERTS: caller,
        [DEV_TRUST_ENV]: [first, second].join(delimiter),
      }),
    ).toEqual([ONE.trim(), TWO.trim(), THREE.trim()]);
  });

  it("splits a bundle into its certificates", () => {
    const bundle = write("bundle.pem", `# comment\n${ONE}\n${TWO}`);
    expect(trustedCertificates({ [DEV_TRUST_ENV]: bundle })).toEqual([ONE.trim(), TWO.trim()]);
  });

  it("ignores unset variables and files that do not exist", () => {
    const present = write("present.pem", ONE);
    expect(trustedCertificates({})).toEqual([]);
    expect(
      trustedCertificates({
        NODE_EXTRA_CA_CERTS: join(dir, "missing-caller.pem"),
        [DEV_TRUST_ENV]: [join(dir, "missing.pem"), "", present, dir].join(delimiter),
      }),
    ).toEqual([ONE.trim()]);
  });

  it("sees a file as it is on each call", () => {
    const env = { [DEV_TRUST_ENV]: join(dir, "late.pem") };
    expect(trustedCertificates(env)).toEqual([]);
    write("late.pem", ONE);
    expect(trustedCertificates(env)).toEqual([ONE.trim()]);
    write("late.pem", TWO);
    expect(trustedCertificates(env)).toEqual([TWO.trim()]);
  });

  it("returns a certificate once, however many files hold it", () => {
    const caller = write("dup-caller.pem", ONE);
    const first = write("dup-first.pem", `${ONE}${TWO}`);
    // Same certificate, Windows line endings.
    const second = write("dup-second.pem", certificate("T05F", "\r\n"));
    expect(
      trustedCertificates({
        NODE_EXTRA_CA_CERTS: caller,
        [DEV_TRUST_ENV]: [first, second].join(delimiter),
      }),
    ).toEqual([ONE.trim(), TWO.trim()]);
  });

  it("does not let an unterminated certificate swallow the next one", () => {
    const file = write("torn.pem", `-----BEGIN CERTIFICATE-----\nVE9STg==\n${TWO}`);
    expect(trustedCertificates({ [DEV_TRUST_ENV]: file })).toEqual([TWO.trim()]);
  });

  it("reads the process environment by default", () => {
    const file = write("process.pem", ONE);
    const previous = process.env[DEV_TRUST_ENV];
    process.env[DEV_TRUST_ENV] = file;
    try {
      expect(trustedCertificates()).toContain(ONE.trim());
    } finally {
      if (previous === undefined) delete process.env[DEV_TRUST_ENV];
      else process.env[DEV_TRUST_ENV] = previous;
    }
  });
});
