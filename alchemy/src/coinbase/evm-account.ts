import type { Context } from "../context.ts";
import { Resource } from "../resource.ts";
import { alchemy } from "../index.ts";

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
  privateKey?: string;
  /**
   * Whether to adopt an existing account with the same name if it already exists.
   * Without adoption, creation will fail if an account with the same name exists.
   * With adoption, the existing account will be used.
   * @default false
   */
  adopt?: boolean;
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
      apiKeyId: await apiKeyId.plainText(),
      apiKeySecret: await apiKeySecret.plainText(),
      walletSecret: await walletSecret.plainText(),
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
      return this.output;
    }

    // Handle delete phase
    if (this.phase === "delete") {
      // CDP SDK doesn't support deleting accounts
      // Accounts remain in CDP but are no longer tracked by Alchemy
      console.log(`🗑️ Untracking EVM Account: ${this.output?.address}`);
      return;
    }

    let account;

    // Handle account creation/retrieval
    if (props.privateKey) {
      // Import account with private key
      const privateKey =
        typeof props.privateKey === "string"
          ? props.privateKey
          : await props.privateKey.plainText();

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
          const existing = existingAccounts.find(
            (acc) => acc.name === props.name,
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
    const result: EvmAccount = {
      id,
      type: "coinbase::evm-account",
      name: account.name || props.name,
      address: account.address,
    };

    await this.save(result);
    return result;
  },
);
