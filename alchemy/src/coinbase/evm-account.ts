import type { Context } from "../context.ts";
import { Resource } from "../resource.ts";
import alchemy, { type Secret } from "../index.ts";

/**
 * Faucet configuration for requesting testnet tokens
 */
export interface FaucetConfig {
  /**
   * The network to request funds from
   */
  network: "base-sepolia" | "ethereum-sepolia";
  /**
   * The token to request
   */
  token: "eth" | "usdc" | "eurc" | "cbbtc";
}

export interface EvmAccountProps {
  /**
   * Name for the account.
   * Used for identification in CDP.
   */
  name: string;
  /**
   * Optional private key to import an existing account.
   * If not provided, a new account will be created or existing one will be used.
   */
  privateKey?: string | Secret<string>;
  /**
   * Whether to adopt an existing account with the same name if it already exists.
   * Without adoption, creation will fail if an account with the same name exists.
   * With adoption, the existing account will be used.
   * @default false
   */
  adopt?: boolean;
  /**
   * Optional faucet configuration to request testnet tokens after account creation.
   * Each configuration will trigger a faucet request for the specified network and token.
   * Only works on testnets: base-sepolia and ethereum-sepolia.
   *
   * @example
   * ```ts
   * faucet: [
   *   { network: "base-sepolia", token: "eth" },
   *   { network: "base-sepolia", token: "usdc" }
   * ]
   * ```
   */
  faucet?: FaucetConfig[];
}

export interface EvmAccount extends Resource<"coinbase::evm-account"> {
  /**
   * The account name in CDP
   */
  name: string;
  /**
   * The EVM address (same across all EVM networks)
   */
  address: string;
  /**
   * Faucet transaction hashes if faucet was requested
   */
  faucetTransactions?: Array<{
    network: string;
    token: string;
    transactionHash: string;
  }>;
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
 * ## Create account with testnet funds
 *
 * Request testnet tokens automatically after account creation
 *
 * ```ts
 * const account = await EvmAccount("test-account", {
 *   name: "Test Account",
 *   faucet: [
 *     { network: "base-sepolia", token: "eth" },
 *     { network: "base-sepolia", token: "usdc" }
 *   ]
 * });
 *
 * console.log("Faucet transactions:", account.faucetTransactions);
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
 *   privateKey: alchemy.secret("COINBASE_PRIVATE_KEY")
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
    this: Context,
    id: string,
    props: EvmAccountProps,
  ): Promise<EvmAccount> {
    const { CdpClient } = await import("@coinbase/cdp-sdk");

    // Initialize CDP client
    const apiKeyId = alchemy.secret("COINBASE_API_KEY_ID");
    const apiKeySecret = alchemy.secret("COINBASE_API_KEY_SECRET");
    const walletSecret = alchemy.secret("COINBASE_WALLET_SECRET");

    const cdp = new CdpClient({
      apiKeyId: apiKeyId.unencrypted,
      apiKeySecret: apiKeySecret.unencrypted,
      walletSecret: walletSecret.unencrypted,
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
        const result: EvmAccount = {
          ...this.output,
          name: updated.name || props.name,
        };
        await this.save(result);
        return result;
      }

      // Check if faucet config changed (would need to request new tokens)
      if (
        props.faucet &&
        JSON.stringify(props.faucet) !==
          JSON.stringify(
            this.output.faucetTransactions?.map((f: any) => ({
              network: f.network,
              token: f.token,
            })),
          )
      ) {
        // Request faucet for new configurations
        const existingFaucets = this.output.faucetTransactions || [];
        const newFaucetTransactions = [...existingFaucets];

        for (const faucetConfig of props.faucet) {
          // Check if this combination already exists
          const exists = existingFaucets.some(
            (f: any) =>
              f.network === faucetConfig.network &&
              f.token === faucetConfig.token,
          );

          if (!exists) {
            console.log(
              `💧 Requesting ${faucetConfig.token} on ${faucetConfig.network} from faucet...`,
            );
            try {
              const faucetResp = await cdp.evm.requestFaucet({
                address: this.output.address,
                network: faucetConfig.network,
                token: faucetConfig.token,
              });

              newFaucetTransactions.push({
                network: faucetConfig.network,
                token: faucetConfig.token,
                transactionHash: faucetResp.transactionHash,
              });

              console.log(
                `✅ Faucet request successful: ${faucetResp.transactionHash}`,
              );
            } catch (error) {
              console.warn(
                `⚠️ Faucet request failed for ${faucetConfig.token} on ${faucetConfig.network}:`,
                error,
              );
            }
          }
        }

        const result: EvmAccount = {
          ...this.output,
          faucetTransactions: newFaucetTransactions,
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
      console.log(`🗑️ Untracking EVM Account: ${this.output?.address}`);
      return {} as any;
    }

    let account;

    // Handle account creation/retrieval
    if (props.privateKey) {
      // Import account with private key
      const privateKey =
        typeof props.privateKey === "string"
          ? props.privateKey
          : (props.privateKey as Secret<string>).unencrypted;

      // Import account - this is idempotent in CDP
      account = await cdp.evm.importAccount({
        privateKey,
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

    // Request faucet if configured
    let faucetTransactions: EvmAccount["faucetTransactions"];

    if (props.faucet && props.faucet.length > 0) {
      faucetTransactions = [];

      for (const faucetConfig of props.faucet) {
        console.log(
          `💧 Requesting ${faucetConfig.token} on ${faucetConfig.network} from faucet...`,
        );
        try {
          const faucetResp = await cdp.evm.requestFaucet({
            address: account.address,
            network: faucetConfig.network,
            token: faucetConfig.token,
          });

          faucetTransactions.push({
            network: faucetConfig.network,
            token: faucetConfig.token,
            transactionHash: faucetResp.transactionHash,
          });

          console.log(
            `✅ Faucet request successful: ${faucetResp.transactionHash}`,
          );
        } catch (error) {
          console.warn(
            `⚠️ Faucet request failed for ${faucetConfig.token} on ${faucetConfig.network}:`,
            error,
          );
        }
      }
    }

    // Return account details
    const result: EvmAccount = {
      name: account.name || props.name,
      address: account.address,
      ...(faucetTransactions && { faucetTransactions }),
    } as EvmAccount;

    await this.save(result);
    return result;
  },
);
