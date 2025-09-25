import type { Context } from "../context.ts";
import { Resource } from "../resource.ts";
import { alchemy } from "../index.ts";
import type { EvmAccount } from "./evm-account.ts";

export interface EvmSmartAccountProps {
  /**
   * Name for the smart account.
   * Used for identification in CDP.
   */
  name: string;
  /**
   * The owner account that controls this smart account.
   * Can be either an EvmAccount resource or an account name string.
   */
  owner: EvmAccount | string;
  /**
   * Whether to adopt an existing smart account with the same name if it already exists.
   * Without adoption, creation will fail if a smart account with the same name exists.
   * With adoption, the existing smart account will be used.
   * @default false
   */
  adopt?: boolean;
}

export interface EvmSmartAccount
  extends Resource<"coinbase::evm-smart-account"> {
  /**
   * The smart account name in CDP
   */
  name: string;
  /**
   * The smart account address (same across all EVM networks)
   */
  address: string;
  /**
   * The owner account address
   */
  ownerAddress: string;
}

/**
 * Manages ERC-4337 smart accounts on Coinbase Developer Platform.
 * Smart accounts enable gasless transactions and advanced features like batch operations.
 *
 * Note: Smart accounts have the same address across all EVM networks.
 * Currently supported on Base Sepolia and Base Mainnet.
 *
 * @example
 * ## Create a smart account with an EVM account owner
 *
 * ```ts
 * const owner = await EvmAccount("owner", {
 *   name: "Owner Account"
 * });
 *
 * const smartAccount = await EvmSmartAccount("my-smart-account", {
 *   name: "My Smart Account",
 *   owner: owner
 * });
 *
 * console.log("Smart account address:", smartAccount.address);
 * // Use for gasless transactions on supported networks:
 * // await cdp.evm.sendUserOperation({
 * //   smartAccount: { address: smartAccount.address },
 * //   network: "base-sepolia",
 * //   ...
 * // })
 * ```
 *
 * @example
 * ## Create a smart account with existing owner
 *
 * ```ts
 * const smartAccount = await EvmSmartAccount("my-smart-account", {
 *   name: "My Smart Account",
 *   owner: "existing-owner-name"
 * });
 * ```
 *
 * @example
 * ## Adopt an existing smart account
 *
 * ```ts
 * const smartAccount = await EvmSmartAccount("my-smart-account", {
 *   name: "existing-smart-account",
 *   owner: "owner-account",
 *   adopt: true // Uses existing smart account if it exists
 * });
 * ```
 */
export const EvmSmartAccount = Resource(
  "coinbase::evm-smart-account",
  async function (
    this: Context,
    id: string,
    props: EvmSmartAccountProps,
  ): Promise<EvmSmartAccount> {
    const { CdpClient } = await import("@coinbase/cdp-sdk");

    // Initialize CDP client
    const apiKeyId = alchemy.secret("COINBASE_API_KEY_ID");
    const apiKeySecret = alchemy.secret("COINBASE_API_KEY_SECRET");
    const walletSecret = alchemy.secret("COINBASE_WALLET_SECRET");

    const cdp = new CdpClient({
      apiKeyId: await apiKeyId.plainText(),
      apiKeySecret: await apiKeySecret.plainText(),
      walletSecret: await walletSecret.plainText(),
    });

    // Get owner account
    let ownerAccount;
    let ownerAddress: string;

    if (typeof props.owner === "string") {
      // Owner is a name string
      // Get or create the owner account
      ownerAccount = await cdp.evm.getOrCreateAccount({
        name: props.owner,
      });
      ownerAddress = ownerAccount.address;
    } else {
      // Owner is an EvmAccount resource
      ownerAddress = props.owner.address;
      // Get or create the owner account in CDP
      ownerAccount = await cdp.evm.getOrCreateAccount({
        name: props.owner.name,
      });
    }

    // Handle update phase
    if (this.phase === "update" && this.output) {
      // Check if owner changed (which would require replacement)
      if (ownerAddress !== this.output.ownerAddress) {
        this.replace();
      }
      // Check if name changed
      if (props.name !== this.output.name) {
        // Note: CDP SDK might not support updating smart account names directly
        // For now, we'll just update our tracking
        const result: EvmSmartAccount = {
          ...this.output,
          name: props.name,
        };
        await this.save(result);
        return result;
      }
      return this.output;
    }

    // Handle delete phase
    if (this.phase === "delete") {
      // CDP SDK doesn't support deleting accounts
      // Accounts remain in CDP but are no longer tracked by Alchemy
      console.log(`🗑️ Untracking Smart Account: ${this.output?.address}`);
      return;
    }

    let smartAccount;

    // Check for adoption or use getOrCreate pattern
    if (props.adopt) {
      // With adoption, use getOrCreateSmartAccount which returns existing if it exists
      smartAccount = await cdp.evm.getOrCreateSmartAccount({
        name: props.name,
        owner: ownerAccount,
      });
    } else {
      // Without adoption, need to check if smart account exists first
      try {
        // List accounts and check if a smart account with this name exists
        const accounts = await cdp.evm.listAccounts();
        const existing = accounts.find(
          (acc) => acc.name === props.name && acc.type === "smart",
        );

        if (existing) {
          throw new Error(
            `Smart account with name '${props.name}' already exists. Use adopt: true to use the existing smart account.`,
          );
        }

        // Create new smart account
        smartAccount = await cdp.evm.createSmartAccount({
          name: props.name,
          owner: ownerAccount,
        });
      } catch (error: any) {
        // If it's our "already exists" error, re-throw it
        if (error.message?.includes("already exists")) {
          throw error;
        }
        // Otherwise, fall back to getOrCreateSmartAccount
        smartAccount = await cdp.evm.getOrCreateSmartAccount({
          name: props.name,
          owner: ownerAccount,
        });
      }
    }

    // Return smart account details
    const result: EvmSmartAccount = {
      id,
      type: "coinbase::evm-smart-account",
      name: smartAccount.name || props.name,
      address: smartAccount.address,
      ownerAddress,
    };

    await this.save(result);
    return result;
  },
);
