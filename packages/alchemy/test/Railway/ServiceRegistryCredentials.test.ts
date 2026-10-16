import { describe, expect, it } from "alchemy-test";
import * as Redacted from "effect/Redacted";
import {
  registryCredentialsDigest,
  registryCredentialsToSend,
} from "@/Railway/ServiceRegistryCredentials.ts";

const credentials = { username: "deploy-bot", password: Redacted.make("ghp_example") };

describe("Railway service registry credentials", () => {
  it("sends credentials that were never written", () => {
    expect(registryCredentialsToSend(credentials, undefined)).toEqual({
      username: "deploy-bot",
      password: "ghp_example",
    });
  });

  it("skips credentials whose fingerprint was already recorded", () => {
    expect(
      registryCredentialsToSend(credentials, registryCredentialsDigest(credentials)),
    ).toBeUndefined();
  });

  it("sends a rotated password or a changed username", () => {
    const recorded = registryCredentialsDigest(credentials);
    expect(
      registryCredentialsToSend({ ...credentials, password: "ghp_rotated" }, recorded),
    ).toEqual({ username: "deploy-bot", password: "ghp_rotated" });
    expect(registryCredentialsToSend({ ...credentials, username: "other" }, recorded)).toEqual({
      username: "other",
      password: "ghp_example",
    });
  });

  it("leaves credentials alone when the prop is omitted", () => {
    expect(registryCredentialsToSend(undefined, undefined)).toBeUndefined();
  });

  it("fingerprints plain and redacted passwords the same way", () => {
    expect(registryCredentialsDigest({ username: "deploy-bot", password: "ghp_example" })).toEqual(
      registryCredentialsDigest(credentials),
    );
  });
});
