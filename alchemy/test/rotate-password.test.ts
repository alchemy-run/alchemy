import { describe, expect, test } from "vitest";
import { alchemy } from "../src/alchemy.ts";
import { type Secret, secret } from "../src/secret.ts";

describe("Password Rotation", () => {
  test("rotates password for secrets", async () => {
    const oldPassword = "old-secret-password-123";
    const newPassword = "new-secure-password-456";

    // Create an app with the old password
    const app = await alchemy("test-app-rotate", {
      password: oldPassword,
      quiet: true,
    });

    // Store a secret value in scope data (simulating resource with secrets)
    const stageScope = Array.from(app.children.values())[0];
    await stageScope.set("test-secret", secret("my-secret-value"));
    await stageScope.set("normal-data", "not-a-secret");

    await app.finalize();

    // Rotate the password
    console.log("Starting password rotation...");
    await alchemy.rotatePassword(oldPassword, newPassword);
    console.log("Password rotation complete");

    // Verify rotation by creating a new app with the new password
    const app2 = await alchemy("test-app-rotate", {
      password: newPassword,
      quiet: true,
      phase: "read",
    });

    const stageScope2 = Array.from(app2.children.values())[0];

    // Should be able to read the secret with new password
    const rotatedSecret = await stageScope2.get<Secret>("test-secret");
    const normalData = await stageScope2.get<string>("normal-data");

    expect(rotatedSecret).toBeDefined();
    expect(rotatedSecret?.unencrypted).toBe("my-secret-value");
    expect(normalData).toBe("not-a-secret");

    // Verify old password no longer works
    const app3 = await alchemy("test-app-rotate", {
      password: oldPassword,
      quiet: true,
      phase: "read",
    });

    const stageScope3 = Array.from(app3.children.values())[0];

    // Should fail to decrypt with old password
    await expect(stageScope3.get<Secret>("test-secret")).rejects.toThrow();
  });

  test("throws error when passwords are the same", async () => {
    const app = await alchemy("test-app-same", {
      password: "same-password",
      quiet: true,
    });

    await expect(
      alchemy.rotatePassword("same-password", "same-password"),
    ).rejects.toThrow("New password must be different from old password");
  });

  test("rotates password when no secrets exist", async () => {
    const oldPassword = "old-password";
    const newPassword = "new-password";

    const app = await alchemy("test-app-no-secrets", {
      password: oldPassword,
      quiet: true,
    });

    // Store only non-secret data
    const stageScope = Array.from(app.children.values())[0];
    await stageScope.set("normal-data", "not-a-secret");

    await app.finalize();

    // Should complete without errors even with no secrets
    await alchemy.rotatePassword(oldPassword, newPassword);

    // Verify normal data is still accessible
    const app2 = await alchemy("test-app-no-secrets", {
      password: newPassword,
      quiet: true,
      phase: "read",
    });

    const stageScope2 = Array.from(app2.children.values())[0];
    const normalData = await stageScope2.get<string>("normal-data");

    expect(normalData).toBe("not-a-secret");
  });
});
