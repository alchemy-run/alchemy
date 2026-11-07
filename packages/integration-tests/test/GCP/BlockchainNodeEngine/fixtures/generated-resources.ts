import * as GCP from "@alchemy.run/gcp";

/** The Ethereum testnet node the generated Blockchain Node Engine bindings bind. */
export const ProbeNode = GCP.BlockchainNodeEngine.BlockchainNode("ProbeNode", {
  location: "us-central1",
  blockchainType: "ETHEREUM",
  ethereumDetails: {
    network: "TESTNET_SEPOLIA",
    nodeType: "FULL",
    executionClient: "GETH",
    consensusClient: "LIGHTHOUSE",
  },
});
