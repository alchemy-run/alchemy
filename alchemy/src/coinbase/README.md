# Coinbase Provider

This provider enables management of blockchain resources through the Coinbase Developer Platform (CDP) SDK.

## Resources

### EVM Account (`coinbase::evm-account`)

Manages standard Ethereum Virtual Machine (EVM) accounts that work across all EVM networks.

**Features:**
- Create new EVM accounts (network-agnostic)
- Import existing accounts via private key
- Adopt existing accounts with the same name
- Update account names
- Follows Alchemy's standard adoption pattern

**Documentation:** [EVM Account Resource](./evm-account.ts)

### EVM Smart Account (`coinbase::evm-smart-account`)

Manages ERC-4337 smart accounts that enable advanced features like gasless transactions.

**Features:**
- Create smart accounts with EVM account owners
- Batch transaction support
- Gasless transactions via paymasters (Base networks)
- Owner replacement triggers resource replacement
- Follows Alchemy's standard adoption pattern

**Documentation:** [EVM Smart Account Resource](./evm-smart-account.ts)

## Prerequisites

1. **CDP API Keys**: Obtain API credentials from the [Coinbase Developer Platform Portal](https://portal.cdp.coinbase.com/)

2. **Environment Variables**: Set the following secrets:
   ```bash
   COINBASE_API_KEY_ID=your-api-key-id
   COINBASE_API_KEY_SECRET=your-api-key-secret
   COINBASE_WALLET_SECRET=your-wallet-secret
   ```

## Key Concepts

### Network-Agnostic Accounts

EVM accounts in CDP have the same address across all EVM networks. You don't specify a network when creating an account - the network is only specified when performing operations like sending transactions:

```typescript
const account = await EvmAccount("my-account", {
  name: "My Account"
});

// Use the same account on different networks:
await cdp.evm.sendTransaction({
  address: account.address,
  network: "base-sepolia",
  // ...
});

await cdp.evm.sendTransaction({
  address: account.address,
  network: "ethereum", 
  // ...
});
```

### Resource Adoption

Following Alchemy's standard adoption pattern:
- **Without adoption (default)**: Creation fails if an account with the same name already exists
- **With adoption**: Uses the existing account if it exists
- Can be set per-resource with `adopt: true` or globally with `alchemy deploy --adopt`

This ensures explicit control over resource reuse and prevents accidental overwrites.

## Usage Examples

### Standard Account Creation

```typescript
import { EvmAccount } from "alchemy/coinbase";

const account = await EvmAccount("my-account", {
  name: "My Account"
});

console.log(`Account created: ${account.address}`);
```

### Import Existing Account

```typescript
import { EvmAccount } from "alchemy/coinbase";
import { alchemy } from "alchemy";

const account = await EvmAccount("imported", {
  name: "Imported Account",
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
  name: "Owner Account"
});

// Then create a smart account
const smartAccount = await EvmSmartAccount("smart", {
  name: "Smart Account",
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
  name: "Original Name"
});

// Update name (address remains the same)
const updated = await EvmAccount("my-account", {
  name: "New Name"
});

console.log(updated.address === account.address); // true
```

### Owner Changes and Replacement

For smart accounts, changing the owner triggers a replacement:

```typescript
const owner1 = await EvmAccount("owner1", { name: "Owner 1" });
const owner2 = await EvmAccount("owner2", { name: "Owner 2" });

// Initial smart account
const smart = await EvmSmartAccount("smart", {
  name: "Smart Account",
  owner: owner1
});

// Changing owner triggers replacement (new smart account)
const replaced = await EvmSmartAccount("smart", {
  name: "Smart Account",
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