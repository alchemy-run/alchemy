import type { Context } from "../context.ts";
import type { Secret } from "../index.ts";
import { Resource } from "../resource.ts";
import { createCdpClient, type CoinbaseClientOptions } from "./client.ts";
import type { Address, FaucetConfig, PrivateKey } from "./types.ts";

// Re-export types for backward compatibility
export type { FaucetConfig, FaucetNetwork, FaucetToken } from "./types.ts";

export interface EvmAccountProps extends CoinbaseClientOptions {
  /**
   * Name for the account.
   * Used for identification in CDP.
   */
  name: string;
  /**
   * Optional private key to import an existing account.
   * Must be a hex string (starting with 0x) encrypted using alchemy.secret().
   * If not provided, a new account will be created or existing one will be used.
   *
   * @example
   * ```ts
   * privateKey: alchemy.secret(process.env.PRIVATE_KEY)
   * ```
   */
  privateKey?: Secret<PrivateKey>;
  /**
   * Whether to adopt an existing account with the same name if it already exists.
   * Without adoption, creation will fail if an account with the same name exists.
   * With adoption, the existing account will be used.
   * @default false
   */
  adopt?: boolean;
  /**
   * Faucet configuration for development funding.
   * Declares which tokens this account should have.
   * Used by external funding scripts - not processed by the resource.
   *
   * @example
   * ```ts
   * faucet: {
   *   "base-sepolia": ["eth", "usdc"],
   *   "ethereum-sepolia": ["eth"]
   * }
   * ```
   */
  faucet?: FaucetConfig;
}

export interface EvmAccount extends Resource<"coinbase::evm-account"> {
  /**
   * The account name in CDP
   */
  name: string;
  /**
   * The EVM address (same across all EVM networks)
   */
  address: Address;
  /**
   * Faucet configuration (passed through from props)
   */
  faucet?: FaucetConfig;
}

/**
 * Manages EVM accounts on Coinbase Developer Platform.
 *
 * Note: EVM accounts have the same address across all EVM networks.
 * The account is network-agnostic and can be used on any supported network.
 *
 * @example
 * ## Create a new EVM account
 *
 * Creates a new EVM account that works across all networks
 *
 * ```ts
 * const account = await EvmAccount("my-account", {
 *   name: "My Account"
 * });
 *
 * console.log("Account address:", account.address);
 * // Use this account on any network:
 * // await cdp.evm.sendTransaction({
 * //   address: account.address,
 * //   network: "base-sepolia",
 * //   ...
 * // })
 * ```
 *
 * @example
 * ## Create account with funding metadata
 *
 * Declare what tokens this account needs for development
 *
 * ```ts
 * const account = await EvmAccount("test-account", {
 *   name: "Test Account",
 *   faucet: {
 *     "base-sepolia": ["eth", "usdc"],
 *     "ethereum-sepolia": ["eth"]
 *   }
 * });
 *
 * // Use a funding script to actually request tokens
 * // based on the faucet configuration
 * ```
 *
 * @example
 * ## Import an existing account
 *
 * Import an existing EVM account using a private key
 *
 * ```ts
 * const account = await EvmAccount("imported-account", {
 *   name: "Imported Account",
 *   privateKey: alchemy.secret(process.env.COINBASE_PRIVATE_KEY)
 * });
 * ```
 *
 * @example
 * ## Adopt an existing account
 *
 * Use an existing account with the same name if it exists
 *
 * ```ts
 * const account = await EvmAccount("my-account", {
 *   name: "existing-account",
 *   adopt: true // Uses existing account if it exists
 * });
 * ```
 */
export const EvmAccount = Resource(
  "coinbase::evm-account",
  async function (
    this: Context<EvmAccount>,
    _id: string,
    props: EvmAccountProps,
  ): Promise<EvmAccount> {
    // Initialize CDP client with credentials from props or environment
    const cdp = await createCdpClient({
      apiKeyId: props.apiKeyId,
      apiKeySecret: props.apiKeySecret,
      walletSecret: props.walletSecret,
    });

    // Handle update phase
    if (this.phase === "update" && this.output) {
      // Only name can be updated
      if (props.name !== this.output.name) {
        // CDP SDK supports updating account names via updateAccount
        const updated = await cdp.evm.updateAccount({
          address: this.output.address,
          update: {
            name: props.name,
          },
        });
        return {
          ...this.output,
          name: updated.name || props.name,
        };
      }

      // Update faucet configuration if changed
      if (JSON.stringify(props.faucet) !== JSON.stringify(this.output.faucet)) {
        return {
          ...this.output,
          faucet: props.faucet,
        };
      }

      return this.output;
    }

    // Handle delete phase
    if (this.phase === "delete") {
      // CDP SDK doesn't support deleting accounts
      // Accounts remain in CDP but are no longer tracked by Alchemy
      console.log(`🗑️ Untracking EVM Account: ${this.output?.address}`);
      return {} as any;
    }

    let account;

    // Handle account creation/retrieval
    if (props.privateKey) {
      // Import account with private key
      const privateKey = props.privateKey.unencrypted;

      // Import account - this is idempotent in CDP
      account = await cdp.evm.importAccount({
        privateKey: privateKey,
        name: props.name,
      });
    } else {
      // Check for adoption or use getOrCreate pattern
      if (props.adopt) {
        // With adoption, use getOrCreate which returns existing if it exists
        account = await cdp.evm.getOrCreateAccount({
          name: props.name,
        });
      } else {
        // Without adoption, need to check if account exists first
        try {
          // Try to get existing account by name
          // CDP SDK doesn't have a direct "getAccountByName" so we use getOrCreate
          // and check if it's actually new or existing
          const existingAccounts = await cdp.evm.listAccounts();
          const existing = (existingAccounts as unknown as any[]).find(
            (acc: any) => acc.name === props.name,
          );

          if (existing) {
            throw new Error(
              `Account with name '${props.name}' already exists. Use adopt: true to use the existing account.`,
            );
          }

          // Create new account
          account = await cdp.evm.createAccount({
            name: props.name,
          });
        } catch (error: any) {
          // If it's our "already exists" error, re-throw it
          if (error.message?.includes("already exists")) {
            throw error;
          }
          // Otherwise, fall back to getOrCreate
          account = await cdp.evm.getOrCreateAccount({
            name: props.name,
          });
        }
      }
    }

    // Return account details
    return {
      name: account.name || props.name,
      address: account.address,
      faucet: props.faucet,
    } as EvmAccount;
  },
);
