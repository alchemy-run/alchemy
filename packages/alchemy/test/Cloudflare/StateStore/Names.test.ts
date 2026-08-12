import { stateStoreCredentialsFile } from "@/Cloudflare/StateStore/CredentialsFile.ts";
import {
  STATE_STORE_SCRIPT_NAME,
  authTokenSecretName,
  encryptionKeySecretName,
} from "@/Cloudflare/StateStore/Names.ts";
import { classifyStoreVersion } from "@/Cloudflare/StateStore/State.ts";
import { describe, expect, it } from "alchemy-test";

/**
 * Pure coverage for the per-store identity derivation (#912) and the
 * monotonic version classification (#1194). No cloud access.
 */

describe("classifyStoreVersion", () => {
  it("matches when the deployed store equals the client contract", () => {
    expect(classifyStoreVersion(7, 7)).toBe("match");
  });

  it("is missing when no version could be observed", () => {
    expect(classifyStoreVersion(7, undefined)).toBe("missing");
  });

  it("is store-older when the deployed store predates the client (upgradable)", () => {
    expect(classifyStoreVersion(7, 5)).toBe("store-older");
    expect(classifyStoreVersion(7, 6)).toBe("store-older");
  });

  it("is store-newer when the deployed store postdates the client (fail closed)", () => {
    expect(classifyStoreVersion(5, 7)).toBe("store-newer");
    expect(classifyStoreVersion(7, 8)).toBe("store-newer");
  });
});

describe("per-store identities", () => {
  it("the default store keeps its historical identities", () => {
    expect(authTokenSecretName(STATE_STORE_SCRIPT_NAME)).toBe(
      "AlchemyStateStoreToken",
    );
    expect(encryptionKeySecretName(STATE_STORE_SCRIPT_NAME)).toBe(
      "AlchemyStateStoreEncryptionKey",
    );
    expect(stateStoreCredentialsFile(STATE_STORE_SCRIPT_NAME)).toBe(
      "cloudflare-state-store",
    );
  });

  it("named stores get suffixed identities", () => {
    expect(authTokenSecretName("alchemy-state-store-team-a")).toBe(
      "AlchemyStateStoreToken_alchemy_state_store_team_a",
    );
    expect(encryptionKeySecretName("alchemy-state-store-team-a")).toBe(
      "AlchemyStateStoreEncryptionKey_alchemy_state_store_team_a",
    );
    expect(stateStoreCredentialsFile("alchemy-state-store-team-a")).toBe(
      "cloudflare-state-store-alchemy-state-store-team-a",
    );
  });

  it("two named stores never share a secret or credential identity", () => {
    const a = "alchemy-state-store-team-a";
    const b = "alchemy-state-store-team-b";
    expect(authTokenSecretName(a)).not.toBe(authTokenSecretName(b));
    expect(encryptionKeySecretName(a)).not.toBe(encryptionKeySecretName(b));
    expect(stateStoreCredentialsFile(a)).not.toBe(stateStoreCredentialsFile(b));
    expect(authTokenSecretName(a)).not.toBe(
      authTokenSecretName(STATE_STORE_SCRIPT_NAME),
    );
  });
});
