# Coinbase Provider

This provider brings blockchain resources as first-class citizens to Infrastructure as Code. Just as you provision databases, servers, and CDNs, you can now declaratively manage blockchain accounts and smart contracts through Alchemy, powered by the Coinbase Developer Platform (CDP) SDK.

## Resources

### EVM Account (`coinbase::evm-account`)


**Features:**
- Create new EVM EOA Accounts (Externally Owned Accounts)  
- Import existing accounts via private key
- Adopt existing accounts with the same name
- Update account names
- Configure testnet tokens to be used with coinbase-faucet script

**Documentation:** [EVM Account Resource](./evm-account.ts)

### EVM Smart Account (`coinbase::evm-smart-account`)

Manages ERC-4337 smart accounts that enable advanced features like gasless transactions.

**Features:**
- Create smart accounts with EVM account owners
- Batch transaction support
- Gasless transactions via paymasters (Base networks)
- Owner replacement triggers resource replacement

**Documentation:** [EVM Smart Account Resource](./evm-smart-account.ts)

## Prerequisites

1. **CDP API Keys**: Obtain API credentials from the [Coinbase Developer Platform Portal](https://portal.cdp.coinbase.com/)

2. **Authentication**: The CDP SDK automatically looks for credentials in environment variables. You can provide them via:

   **Environment Variables** (recommended - CDP SDK standard):
   ```bash
   CDP_API_KEY_ID=your-api-key-id
   CDP_API_KEY_SECRET=your-api-key-secret
   CDP_WALLET_SECRET=your-wallet-secret
   ```

   **Or override with resource-specific credentials**:
   ```typescript
   import alchemy from "alchemy";
   import { EvmAccount } from "alchemy/coinbase";

   const account = await EvmAccount("my-account", {
     name: "my-account",
     apiKeyId: alchemy.secret("CUSTOM_API_KEY_ID"),
     apiKeySecret: alchemy.secret("CUSTOM_API_KEY_SECRET"),
     walletSecret: alchemy.secret("CUSTOM_WALLET_SECRET")
   });
   ```

   > **Note**: If no credentials are provided in the resource props, the CDP SDK will automatically use the `CDP_*` environment variables.

## Key Concepts

### Automatic Faucet Funding

When `faucet` configuration is provided, accounts automatically request testnet tokens:

- **On Creation**: Accounts receive initial funding when created with `faucet` config
- **On Update**: Adding new networks/tokens to `faucet` config automatically requests those funds
- **Non-blocking**: Funding failures don't prevent account operations (warnings are logged)
- **Smart Accounts**: Both regular and smart accounts support auto-funding

This eliminates the need to manually run faucet scripts in most cases. The separate faucet script is still available for bulk operations or re-funding.

### Security: Encrypted Secrets

Private keys **must** be encrypted using `alchemy.secret()` to ensure they are never exposed in state files:

```typescript
import type { PrivateKey } from "alchemy/coinbase";

// ✅ CORRECT - Private key is encrypted in state
const account = await EvmAccount("treasury", {
  name: "treasury",
  privateKey: alchemy.secret(process.env.TREASURY_KEY)
});

// ❌ WRONG - Would expose private key in plain text (TypeScript will error)
const account = await EvmAccount("treasury", {
  name: "treasury",
  privateKey: process.env.TREASURY_KEY // Type error: must be Secret<PrivateKey>
});
```

This ensures that:
- Private keys are encrypted before being stored in state
- State files can be safely committed to version control
- Only users with the Alchemy password can decrypt and use the accounts

### Resource Adoption

Following Alchemy's standard adoption pattern:
- **Without adoption (default)**: Creation fails if an account with the same name already exists
- **With adoption**: Uses the existing account if it exists
- Can be set per-resource with `adopt: true` or globally with `alchemy deploy --adopt`

This ensures explicit control over resource reuse and prevents accidental overwrites.

## Faucet Script

Request testnet tokens for accounts configured with faucet metadata.

### Installation & Setup

Add to your `package.json` scripts:
```json
{
  "scripts": {
    "faucet": "bun node_modules/alchemy/src/coinbase/faucet.ts"
  }
}
```

### Usage

```bash
# Fund all accounts with faucet configuration across all scopes
bun run faucet

# Fund only accounts in 'dev' stage scope
bun run faucet dev
```

The script supports Alchemy's [Stage Scope](https://alchemy.run/concepts/scope/#stage-scope) pattern, allowing you to target specific environments by passing the stage name as an argument.

### How it works

1. **Scope Detection**:
   - No argument: Searches all `.alchemy` subdirectories
   - With stage argument: Finds all scopes matching that stage (e.g., `dev` matches `backend/dev`, `frontend/dev`)

2. **Account Discovery**: Finds all Coinbase EVM accounts and smart accounts with `faucet` metadata

3. **Token Requests**: For each account, requests tokens from CDP faucet for configured network/token pairs

4. **Idempotency**: Tracks funded combinations to avoid duplicates within the same run

5. **Rate Limiting**: Automatically handles CDP faucet rate limits

### Requirements

- CDP credentials must be set as environment variables:
  - `CDP_API_KEY_ID`
  - `CDP_API_KEY_SECRET`
  - `CDP_WALLET_SECRET`
- Accounts must have `faucet` metadata configured (see examples above)


## Usage Examples

### Standard Account Creation

```typescript
import { EvmAccount } from "alchemy/coinbase";

const account = await EvmAccount("my-account", {
  name: "my-account"
});

console.log(`Account created: ${account.address}`);
```

### Create Account with Automatic Testnet Funding

Accounts automatically request faucet funds when created with `faucet` configuration:

```typescript
import { EvmAccount } from "alchemy/coinbase";

const account = await EvmAccount("test-account", {
  name: "test-account",
  faucet: {
    "base-sepolia": ["eth", "usdc"],
    "ethereum-sepolia": ["eth"]
  }
});

console.log(`Account created and funded: ${account.address}`);
// The account automatically receives ETH and USDC on Base Sepolia, and ETH on Ethereum Sepolia
```

**Note**: Faucet requests are non-blocking. If funding fails (e.g., rate limits, network issues), the account is still created successfully with a warning logged.

### Import Existing Account

```typescript
import { EvmAccount, type PrivateKey } from "alchemy/coinbase";
import alchemy from "alchemy";

const account = await EvmAccount("imported", {
  name: "imported-account",
  privateKey: alchemy.secret(process.env.PRIVATE_KEY)
});
```

### Adopt Existing Account

```typescript
import { EvmAccount } from "alchemy/coinbase";

// Without adoption - fails if account already exists
const account = await EvmAccount("my-account", {
  name: "existing-account"
  // adopt: false is the default
});

// With adoption - uses existing account if it exists
const account = await EvmAccount("my-account", {
  name: "existing-account",
  adopt: true
});
```

### Smart Account (ERC-4337) with Auto-Funding

Smart accounts also support automatic funding on creation and updates:

```typescript
import { EvmAccount, EvmSmartAccount } from "alchemy/coinbase";

// First create an owner account
const owner = await EvmAccount("owner", {
  name: "owner-account"
});

// Then create a smart account with explicit name and auto-funding
const smartAccount = await EvmSmartAccount("smart", {
  name: "smart-account",
  owner: owner,
  faucet: {
    "base-sepolia": ["eth", "usdc"]  // Automatically funded on creation
  }
});

console.log(`Smart account created and funded: ${smartAccount.address}`);

// Use for gasless transactions on Base networks:
await cdp.evm.sendUserOperation({
  smartAccount: { address: smartAccount.address },
  network: "base-sepolia",
  calls: [/* ... */],
  // Gasless by default on Base Sepolia
});
```

### Smart Account with Inherited Name

When `name` is omitted, the smart account inherits the owner's name. This creates matching names in CDP for both EOA and Smart Account:

```typescript
import { EvmAccount, EvmSmartAccount } from "alchemy/coinbase";

const owner = await EvmAccount("owner", {
  name: "my-app-wallet"
});

// Smart account inherits the name "my-app-wallet" from owner
const smartAccount = await EvmSmartAccount("smart", {
  owner: owner
  // name is omitted - will be "my-app-wallet" in CDP
});

console.log(smartAccount.name); // "my-app-wallet"
// Both EOA and Smart Account have the same name in CDP
```

### Adopt Existing Smart Account

```typescript
import { EvmSmartAccount } from "alchemy/coinbase";

// With adoption - uses existing smart account if it exists
const smartAccount = await EvmSmartAccount("my-smart-account", {
  name: "existing-smart-account",
  owner: ownerAccount,
  adopt: true
});
```

### Update Account Name

```typescript
// Initial account
const account = await EvmAccount("my-account", {
  name: "original-name"
});

// Update name (address remains the same)
const updated = await EvmAccount("my-account", {
  name: "new-name"
});

console.log(updated.address === account.address); // true
```

### Update Faucet Configuration with Auto-Funding

When you update the `faucet` configuration, new tokens are automatically requested:

```typescript
// Initial account with ETH on Base Sepolia
const account = await EvmAccount("my-account", {
  name: "test-account",
  faucet: {
    "base-sepolia": ["eth"]
  }
});

// Later, update faucet configuration - automatically requests USDC and Ethereum Sepolia ETH
const updated = await EvmAccount("my-account", {
  name: "test-account",
  faucet: {
    "base-sepolia": ["eth", "usdc"],  // USDC will be automatically requested
    "ethereum-sepolia": ["eth"]        // ETH on new network will be requested
  }
});

console.log("Account automatically funded with new tokens");
```

### Owner Changes and Replacement

For smart accounts, changing the owner triggers a replacement:

```typescript
const owner1 = await EvmAccount("owner1", { name: "owner-1" });
const owner2 = await EvmAccount("owner2", { name: "owner-2" });

// Initial smart account
const smart = await EvmSmartAccount("smart", {
  name: "smart-account",
  owner: owner1
});

// Changing owner triggers replacement (new smart account)
const replaced = await EvmSmartAccount("smart", {
  name: "smart-account",
  owner: owner2 // Different owner
});

console.log(replaced.address !== smart.address); // true - new address
```

## Testing

Run tests for the Coinbase provider:

```bash
bun vitest alchemy/test/coinbase
```

## References

- [Coinbase Developer Platform Documentation](https://docs.cdp.coinbase.com/)
- [CDP SDK TypeScript Reference](https://coinbase.github.io/cdp-sdk/typescript/)
- [Base Network Documentation](https://docs.base.org/)
- [ERC-4337 Account Abstraction](https://eips.ethereum.org/EIPS/eip-4337)