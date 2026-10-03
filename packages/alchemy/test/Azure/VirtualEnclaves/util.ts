import * as Azure from "@/Azure";
import type { Input } from "@/Input";
import type { AzureOpError } from "@distilled.cloud/azure";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const tags = [
  "provider:azure",
  "provider:azure:virtualenclaves",
  "live",
];

export const subscription = Effect.map(
  Azure.AzureEnvironment.current,
  (env) => env.subscriptionId,
);

/**
 * Every Virtual Enclaves lifecycle needs a Community, which deploys a
 * Virtual WAN hub (~$0.25/h) plus an Azure Firewall (Basic ~$0.40/h) and
 * takes 30-60+ minutes to provision and as long to delete.
 */
export const LIFECYCLE_TIMEOUT = 900_000;

/** A community with the cheapest firewall, shared by the child tests. */
export const community = (location = "eastus") =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const community = yield* Azure.VirtualEnclaves.Community("Community", {
      resourceGroup: group.resourceGroupName,
      addressSpace: "10.20.0.0/16",
      firewallSku: "Basic",
    });
    return { group, community };
  });

/** A small enclave in the community. */
export const enclave = (
  id: string,
  resourceGroup: Input<string>,
  communityId: Input<string>,
) =>
  Azure.VirtualEnclaves.VirtualEnclave(id, {
    resourceGroup,
    communityId,
    enclaveVirtualNetwork: {
      networkSize: "small",
      subnetConfigurations: [{ subnetName: "apps", networkPrefixSize: 26 }],
    },
  });

/** Poll an out-of-band GET until it reports a typed not-found. */
export const waitGone = <A, R>(get: Effect.Effect<A, AzureOpError, R>) =>
  get.pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("10 seconds"),
      until: (status) => status === "gone",
      times: 30,
    }),
  );
