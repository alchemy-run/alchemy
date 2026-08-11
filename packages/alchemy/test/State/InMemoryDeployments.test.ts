import { InMemoryService } from "@/State";
import { deploymentStoreConformance } from "./deploymentStoreConformance.ts";

// One shared underlying store for the whole file: the conformance suite
// keys every case by a unique (stack, stage) pair, so cases never interfere
// even though `make` always resolves the same instance.
const service = InMemoryService();

deploymentStoreConformance({
  label: "InMemory DeploymentStore",
  make: () => service,
  persistent: false,
});
