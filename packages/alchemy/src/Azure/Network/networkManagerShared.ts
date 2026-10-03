import * as network from "@distilled.cloud/azure/network";
import * as Effect from "effect/Effect";
import { createPhysicalName } from "../../PhysicalName.ts";
import { orUndefinedIfNotFound } from "../Arm.ts";
import type { NetworkPath } from "./generic.ts";

// Shared by the Network Manager family. Internal: not exported from index.ts.

/** Network Manager child names: 1-64 letters, digits, `_`, `.`, `-`. */
export const networkManagerChildName = (id: string) =>
  createPhysicalName({ id, maxLength: 64 });

/** Tags of the parent network manager (ownership of its tagless children). */
export const networkManagerTags = (subscriptionId: string, path: NetworkPath) =>
  orUndefinedIfNotFound(
    network.GetNetworkManager({
      subscriptionId,
      resourceGroupName: path.resourceGroup,
      networkManagerName: path.networkManager!,
    }),
  ).pipe(Effect.map((manager) => manager?.tags));
