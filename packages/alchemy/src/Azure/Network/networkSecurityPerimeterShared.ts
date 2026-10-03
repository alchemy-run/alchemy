import * as network from "@distilled.cloud/azure/network";
import * as Effect from "effect/Effect";
import { orUndefinedIfNotFound } from "../Arm.ts";
import type { NetworkPath } from "./generic.ts";

// Shared by the network security perimeter family. Internal: not exported
// from index.ts.

/** Tags of the parent perimeter (ownership of its tagless children). */
export const perimeterTags = (subscriptionId: string, path: NetworkPath) =>
  orUndefinedIfNotFound(
    network.GetNetworkSecurityPerimeter({
      subscriptionId,
      resourceGroupName: path.resourceGroup,
      networkSecurityPerimeterName: path.networkSecurityPerimeter!,
    }),
  ).pipe(Effect.map((perimeter) => perimeter?.tags));
