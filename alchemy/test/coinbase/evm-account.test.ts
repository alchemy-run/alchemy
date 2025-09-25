import { alchemy } from "../../src/index.ts";
import { destroy } from "../../src/destroy.ts";
import { EvmAccount } from "../../src/coinbase/evm-account.ts";
import { EvmSmartAccount } from "../../src/coinbase/evm-smart-account.ts";
import { describe, expect } from "vitest";

import "../../src/test/vitest.ts";

const BRANCH_PREFIX = process.env.BRANCH_PREFIX || "test";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

describe("Coinbase", () => {
  describe("EvmAccount", () => {
    test("create standard EVM account", async (scope) => {
      const accountId = `${BRANCH_PREFIX}-standard-account`;
      let account: EvmAccount;

      try {
        // Create account
        account = await EvmAccount(accountId, {
          name: "Test Standard Account",
        });

        expect(account).toMatchObject({
          id: accountId,
          type: "coinbase::evm-account",
          name: "Test Standard Account",
        });
        expect(account.address).toMatch(/^0x[a-fA-F0-9]{40}$/);

        // Update account (should return existing)
        const updatedAccount = await EvmAccount(accountId, {
          name: "Test Standard Account",
        });

        expect(updatedAccount).toMatchObject({
          id: accountId,
          name: account.name,
          address: account.address,
        });
      } finally {
        await destroy(scope);
        // Note: Accounts persist in CDP but are no longer tracked by Alchemy
        console.log(`✅ Account ${account!.address} is no longer tracked`);
      }
    });

    test("import existing EVM account", async (scope) => {
      const accountId = `${BRANCH_PREFIX}-imported-account`;
      let account: EvmAccount;

      try {
        // Import account with private key
        account = await EvmAccount(accountId, {
          name: "Imported Account",
          privateKey: alchemy.secret("TEST_PRIVATE_KEY"),
        });

        expect(account).toMatchObject({
          id: accountId,
          type: "coinbase::evm-account",
          name: "Imported Account",
        });
        expect(account.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
      } finally {
        await destroy(scope);
        console.log(`✅ Account ${account!.address} is no longer tracked`);
      }
    });

    test("update account name", async (scope) => {
      const accountId = `${BRANCH_PREFIX}-update-test`;
      let account: EvmAccount;

      try {
        // Create account
        account = await EvmAccount(accountId, {
          name: "Original Name",
        });

        const originalAddress = account.address;

        // Update name
        const updatedAccount = await EvmAccount(accountId, {
          name: "Updated Name",
        });

        expect(updatedAccount.name).toBe("Updated Name");
        // Address should remain the same
        expect(updatedAccount.address).toBe(originalAddress);
      } finally {
        await destroy(scope);
        console.log(`✅ Account ${account!.address} is no longer tracked`);
      }
    });

    test("adopt existing account", async (scope) => {
      const accountName = `${BRANCH_PREFIX}-adoptable-account`;
      const adopterId = `${BRANCH_PREFIX}-adopter`;

      try {
        // First create an account to adopt
        const originalAccount = await EvmAccount(`${BRANCH_PREFIX}-original`, {
          name: accountName,
        });

        // Adopt it with adopt flag
        const adoptedAccount = await EvmAccount(adopterId, {
          name: accountName,
          adopt: true,
        });

        expect(adoptedAccount).toMatchObject({
          id: adopterId,
          type: "coinbase::evm-account",
          name: accountName,
        });
        // Should have the same address as the original
        expect(adoptedAccount.address).toBe(originalAccount.address);
      } finally {
        await destroy(scope);
      }
    });

    test("fail without adoption when account exists", async (scope) => {
      const accountName = `${BRANCH_PREFIX}-existing-account`;

      try {
        // First create an account
        await EvmAccount(`${BRANCH_PREFIX}-first`, {
          name: accountName,
        });

        // Try to create another with the same name without adoption
        await expect(
          EvmAccount(`${BRANCH_PREFIX}-second`, {
            name: accountName,
            // adopt: false is the default
          }),
        ).rejects.toThrow(/already exists/);
      } finally {
        await destroy(scope);
      }
    });
  });

  describe("EvmSmartAccount", () => {
    test("create smart account with EVM owner", async (scope) => {
      const ownerAccountId = `${BRANCH_PREFIX}-owner-account`;
      const smartAccountId = `${BRANCH_PREFIX}-smart-account`;
      let ownerAccount: EvmAccount;
      let smartAccount: EvmSmartAccount;

      try {
        // Create owner account first
        ownerAccount = await EvmAccount(ownerAccountId, {
          name: "Owner Account",
        });

        // Create smart account
        smartAccount = await EvmSmartAccount(smartAccountId, {
          name: "Smart Account",
          owner: ownerAccount,
        });

        expect(smartAccount).toMatchObject({
          id: smartAccountId,
          type: "coinbase::evm-smart-account",
          name: "Smart Account",
          ownerAddress: ownerAccount.address,
        });
        expect(smartAccount.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
      } finally {
        await destroy(scope);
        console.log(
          `✅ Smart account ${smartAccount!.address} is no longer tracked`,
        );
        console.log(
          `✅ Owner account ${ownerAccount!.address} is no longer tracked`,
        );
      }
    });

    test("owner change triggers replacement", async (scope) => {
      const owner1Id = `${BRANCH_PREFIX}-owner1`;
      const owner2Id = `${BRANCH_PREFIX}-owner2`;
      const smartAccountId = `${BRANCH_PREFIX}-smart-replace`;
      let owner1: EvmAccount;
      let owner2: EvmAccount;
      let smartAccount: EvmSmartAccount;

      try {
        // Create two owner accounts
        owner1 = await EvmAccount(owner1Id, {
          name: "Owner 1",
        });
        owner2 = await EvmAccount(owner2Id, {
          name: "Owner 2",
        });

        // Create smart account with first owner
        smartAccount = await EvmSmartAccount(smartAccountId, {
          name: "Smart Account",
          owner: owner1,
        });

        const originalAddress = smartAccount.address;

        // Change owner (should trigger replacement)
        const replacedAccount = await EvmSmartAccount(smartAccountId, {
          name: "Smart Account",
          owner: owner2,
        });

        expect(replacedAccount.ownerAddress).toBe(owner2.address);
        // Address should be different after replacement
        expect(replacedAccount.address).not.toBe(originalAddress);
      } finally {
        await destroy(scope);
        console.log("✅ Accounts are no longer tracked");
      }
    });

    test("create smart account with owner by name", async (scope) => {
      const ownerName = `${BRANCH_PREFIX}-owner-by-name`;
      const smartAccountId = `${BRANCH_PREFIX}-smart-with-name`;
      let smartAccount: EvmSmartAccount;

      try {
        // Create owner first
        const owner = await EvmAccount(`${smartAccountId}-owner`, {
          name: ownerName,
        });

        // Create smart account with owner by name
        smartAccount = await EvmSmartAccount(smartAccountId, {
          name: `${BRANCH_PREFIX}-smart-account`,
          owner: ownerName,
        });

        expect(smartAccount).toMatchObject({
          id: smartAccountId,
          type: "coinbase::evm-smart-account",
          ownerAddress: owner.address,
        });
      } finally {
        await destroy(scope);
        console.log(
          `✅ Smart account ${smartAccount!.address} is no longer tracked`,
        );
      }
    });

    test("adopt existing smart account", async (scope) => {
      const ownerName = `${BRANCH_PREFIX}-smart-owner`;
      const smartName = `${BRANCH_PREFIX}-adoptable-smart`;
      const adopterId = `${BRANCH_PREFIX}-smart-adopter`;

      try {
        // Create owner
        const owner = await EvmAccount(`${BRANCH_PREFIX}-owner-for-adopt`, {
          name: ownerName,
        });

        // Create original smart account
        const original = await EvmSmartAccount(
          `${BRANCH_PREFIX}-original-smart`,
          {
            name: smartName,
            owner: owner,
          },
        );

        // Adopt it with adopt flag
        const adopted = await EvmSmartAccount(adopterId, {
          name: smartName,
          owner: owner,
          adopt: true,
        });

        expect(adopted).toMatchObject({
          id: adopterId,
          type: "coinbase::evm-smart-account",
          name: smartName,
          address: original.address,
          ownerAddress: owner.address,
        });
      } finally {
        await destroy(scope);
      }
    });
  });
});
