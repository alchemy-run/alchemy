# Coinbase Provider

This provider enables management of blockchain resources through the Coinbase Developer Platform (CDP) SDK.

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
     name: "My Account",
     apiKeyId: alchemy.secret("CUSTOM_API_KEY_ID"),
     apiKeySecret: alchemy.secret("CUSTOM_API_KEY_SECRET"),
     walletSecret: alchemy.secret("CUSTOM_WALLET_SECRET")
   });
   ```

   > **Note**: If no credentials are provided in the resource props, the CDP SDK will automatically use the `CDP_*` environment variables.

## Key Concepts

### Resource Adoption

Following Alchemy's standard adoption pattern:
- **Without adoption (default)**: Creation fails if an account with the same name already exists
- **With adoption**: Uses the existing account if it exists
- Can be set per-resource with `adopt: true` or globally with `alchemy deploy --adopt`

This ensures explicit control over resource reuse and prevents accidental overwrites.

## Faucet Script

Request testnet tokens for accounts configured with faucet metadata.

### Usage

```bash
bunx alchemy/coinbase/faucet
```

Or add to your `package.json` scripts:
```json
{
  "scripts": {
    "faucet": "bunx alchemy/coinbase/faucet"
  }
}
```

### How it works

1. Reads all Coinbase accounts from Alchemy state
2. Finds accounts with `faucet` metadata configuration
3. Requests tokens from CDP faucet for each network/token pair
4. Skips already funded combinations (idempotent)
5. Handles rate limits with automatic delays

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

### Create Account with Testnet Funds

```typescript
import { EvmAccount } from "alchemy/coinbase";

const account = await EvmAccount("test-account", {
  name: "test-account",
  faucet: [
    { network: "base-sepolia", token: "eth" },
    { network: "base-sepolia", token: "usdc" },
    { network: "ethereum-sepolia", token: "usdc" }
  ]
});

console.log(`Account created: ${account.address}`);
console.log(`Faucet transactions:`, account.faucetTransactions);
```

### Import Existing Account

```typescript
import { EvmAccount } from "alchemy/coinbase";
import alchemy from "alchemy";

const account = await EvmAccount("imported", {
  name: "imported-account",
  privateKey: alchemy.secret("PRIVATE_KEY")
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

### Smart Account (ERC-4337)

```typescript
import { EvmAccount, EvmSmartAccount } from "alchemy/coinbase";

// First create an owner account
const owner = await EvmAccount("owner", {
  name: "owner-account"
});

// Then create a smart account
const smartAccount = await EvmSmartAccount("smart", {
  name: "smart-account",
  owner: owner
});

console.log(`Smart account: ${smartAccount.address}`);

// Use for gasless transactions on Base networks:
await cdp.evm.sendUserOperation({
  smartAccount: { address: smartAccount.address },
  network: "base-sepolia",
  calls: [/* ... */],
  // Gasless by default on Base Sepolia
});
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
  name: "0riginal-name"
});

// Update name (address remains the same)
const updated = await EvmAccount("my-account", {
  name: "new-name"
});

console.log(updated.address === account.address); // true
```

### Request Additional Testnet Tokens

```typescript
// Initial account with ETH on Base Sepolia
const account = await EvmAccount("my-account", {
  name: "test-account",
  faucet: [
    { network: "base-sepolia", token: "eth" }
  ]
});

// Later, request additional tokens
const updated = await EvmAccount("my-account", {
  name: "test-account",
  faucet: [
    { network: "base-sepolia", token: "eth" }, // Already exists, skipped
    { network: "base-sepolia", token: "usdc" }, // New request
    { network: "ethereum-sepolia", token: "eth" } // New request
  ]
});

// updated.faucetTransactions now contains all faucet requests
```

### Owner Changes and Replacement

For smart accounts, changing the owner triggers a replacement:

```typescript
const owner1 = await EvmAccount("owner1", { name: "Owner 1" });
const owner2 = await EvmAccount("owner2", { name: "Owner 2" });

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