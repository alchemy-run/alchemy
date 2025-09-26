#!/usr/bin/env bun
/**
 * Request testnet tokens from Coinbase faucet for accounts with faucet metadata
 *
 * Usage:
 *   bunx alchemy/coinbase/faucet
 */

import alchemy from "../index.ts";
import { createCdpClient } from "./client.ts";
import type { EvmAccount } from "./evm-account.ts";
import type { EvmSmartAccount } from "./evm-smart-account.ts";
import type { FaucetNetwork, FaucetToken } from "./types.ts";

// Track funded combinations to avoid duplicates within this run
const funded = new Set<string>();

async function main() {
  // Initialize CDP client (uses CDP_* env vars automatically)
  const cdp = await createCdpClient();

  // Initialize Alchemy scope to access state
  const scope = await alchemy("coinbase-funding", {
    phase: "read",
  });

  // Get all states and filter for Coinbase EVM accounts with faucet metadata
  const allStates = await scope.state.all();

  const accounts = Object.values(allStates)
    .filter(
      (state) =>
        state.kind.startsWith("coinbase::evm") &&
        (state.output as EvmAccount | EvmSmartAccount).faucet,
    )
    .map((state) => {
      const output = state.output as EvmAccount | EvmSmartAccount;
      return {
        address: output.address,
        name: output.name,
        faucet: output.faucet!,
      };
    });

  if (accounts.length === 0) {
    console.log("No accounts with faucet configuration found");
    return;
  }

  console.log(`Found ${accounts.length} accounts with faucet configuration\n`);

  for (const account of accounts) {
    console.log(`Account: ${account.name} (${account.address})`);

    for (const [network, tokens] of Object.entries(account.faucet)) {
      for (const token of tokens) {
        const key = `${account.address}-${network}-${token}`;

        // Skip if already processed in this run
        if (funded.has(key)) {
          console.log(
            `  ⏭️  Skipping ${token} on ${network} (already requested)`,
          );
          continue;
        }

        // Request tokens from faucet
        try {
          console.log(`  💧 Requesting ${token} on ${network}...`);

          const response = await cdp.evm.requestFaucet({
            address: account.address,
            network: network as FaucetNetwork,
            token: token as FaucetToken,
          });

          console.log(`  ✅ Funded: ${response.transactionHash}`);
          funded.add(key);

          // Small delay to avoid rate limits
          await new Promise((resolve) => setTimeout(resolve, 1000));
        } catch (error: any) {
          const errorMsg = error.message || "";

          if (errorMsg.includes("rate limit")) {
            console.log(`  ⚠️  Rate limited for ${token} on ${network}`);
          } else if (errorMsg.includes("already funded")) {
            console.log(`  ✓  Already funded with ${token} on ${network}`);
            funded.add(key);
          } else {
            console.log(
              `  ❌ Error funding ${token} on ${network}: ${errorMsg}`,
            );
          }
        }
      }
    }
    console.log();
  }

  console.log("✨ Funding complete!");
}

main().catch(console.error);
