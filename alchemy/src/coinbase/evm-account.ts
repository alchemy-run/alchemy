import type { Context } from "../context.ts";
import type { Secret } from "../index.ts";
import { Resource } from "../resource.ts";
import { createCdpClient, type CoinbaseClientOptions } from "./client.ts";
import type {
  Address,
  FaucetConfig,
  FaucetNetwork,
  FaucetToken,
  PrivateKey,
} from "./types.ts";
import { validateAccountName } from "./utils.ts";

// Re-export types for backward compatibility
export type { FaucetConfig, FaucetNetwork, FaucetToken } from "./types.ts";

export interface EvmAccountProps extends CoinbaseClientOptions {
  /**
   * Name for the account.
   * Used for identification in CDP.
   * Must contain only letters, numbers, and hyphens.
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
 *   name: "my-account"
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
 *   name: "test-account",
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
 *   name: "imported-account",
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
    // Validate account name format
    validateAccountName(props.name);

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
        await cdp.evm.updateAccount({
          address: this.output.address,
          update: {
            name: props.name,
          },
        });
        return {
          ...this.output,
          name: props.name, // Use the requested name
          faucet: props.faucet,
        };
      }

      // Update faucet configuration if changed
      if (JSON.stringify(props.faucet) !== JSON.stringify(this.output.faucet)) {
        // Only fund NEW combinations that weren't in the previous config
        try {
          // Get all old combinations
          const oldCombinations = new Set(
            Object.entries(this.output.faucet ?? {}).flatMap(
              ([network, tokens]) =>
                tokens.map((token) => `${network}:${token}`),
            ),
          );

          // Get all new combinations
          const newCombinations = Object.entries(props.faucet ?? {}).flatMap(
            ([network, tokens]) =>
              tokens.map((token) => ({
                network: network as FaucetNetwork,
                token: token as FaucetToken,
                key: `${network}:${token}`,
              })),
          );

          // Filter to only combinations that are actually new
          const toFund = newCombinations.filter(
            ({ key }) => !oldCombinations.has(key),
          );

          if (toFund.length > 0) {
            await Promise.all(
              toFund.map(({ network, token }) =>
                cdp.evm
                  .requestFaucet({
                    address: this.output.address,
                    network,
                    token,
                  })
                  .catch((err) => {
                    console.warn(
                      `⚠️ Failed to request ${token} on ${network} for ${this.output.address}: ${err.message}`,
                    );
                    return null;
                  }),
              ),
            );

            console.log(
              `💧 Requested ${toFund.length} new faucet fund${toFund.length === 1 ? "" : "s"} for ${this.output.address}`,
            );
          }
        } catch (error: any) {
          console.warn(
            `⚠️ Failed to request additional faucet funds for ${this.output.address}: ${error.message}`,
          );
          // Continue - don't break the update
        }

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
      console.log(`🗑️ Untracking EVM Account: ${this.output.address}`);
      return {} as any;
    }

    let account;

    // Handle account creation/retrieval
    if (props.privateKey) {
      // Import account with private key
      // This is idempotent in CDP
      account = await cdp.evm.importAccount({
        privateKey: props.privateKey.unencrypted,
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
          await cdp.evm.getAccount({ name: props.name });
          throw new Error(
            `Account with name '${props.name}' already exists. Use adopt: true to use the existing account.`,
          );
        } catch (_error: any) {
          // Account not found, create it
          account = await cdp.evm.createAccount({ name: props.name });
        }
      }
    }

    // Fund the account if faucet configuration is provided
    if (props.faucet) {
      try {
        const combinations = Object.entries(props.faucet).flatMap(
          ([network, tokens]) =>
            tokens.map((token) => ({
              network: network as FaucetNetwork,
              token: token as FaucetToken,
            })),
        );

        await Promise.all(
          combinations.map(({ network, token }) =>
            cdp.evm
              .requestFaucet({
                address: account.address,
                network,
                token,
              })
              .catch((err) => {
                console.warn(
                  `⚠️ Failed to request ${token} on ${network} for ${account.address}: ${err.message}`,
                );
                return null;
              }),
          ),
        );

        console.log(`💧 Requested faucet funds for ${account.address}`);
      } catch (error: any) {
        console.warn(
          `⚠️ Failed to request faucet funds for ${account.address}: ${error.message}`,
        );
        // Continue - don't break account creation
      }
    }

    // Return account details
    return {
      name: props.name, // Always use the name from props for consistency
      address: account.address,
      faucet: props.faucet,
    } as EvmAccount;
  },
);
