import { networkInterfaces } from "node:os";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcess from "effect/process/ChildProcess";
import type { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import { LanUnavailable } from "../Errors.ts";
import * as Host from "./Host.ts";
import { run } from "./Run.ts";

/** The tool Portless publishes `.local` names with on each platform, and how to see it is installed. */
const MDNS_TOOLS: Record<
  string,
  { readonly command: string; readonly probe: ReadonlyArray<string> }
> = {
  darwin: { command: "dns-sd", probe: ["-h"] },
  linux: { command: "avahi-publish-address", probe: ["--help"] },
};

/**
 * An address other machines could reach this one on: an IPv4 address of a
 * physical network, leaving out loopback and the virtual interfaces Portless
 * leaves out too (container bridges, Hyper-V). It looks only for one: Portless
 * picks its own by the default route.
 */
export const networkAddress = Effect.sync((): string | undefined => {
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    if (/^bridge\d+$/.test(name) || name.includes("vEthernet")) continue;
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      if (entry.mac === "00:00:00:00:00:00" || entry.mac.startsWith("00:15:5d")) continue;
      return entry.address;
    }
  }
  return undefined;
});

/** Whether the platform's mDNS tool can be started. A tool that exits non-zero is still there. */
const mdnsInstalled = (tool: { readonly command: string; readonly probe: ReadonlyArray<string> }) =>
  run(ChildProcess.make(tool.command, [...tool.probe])).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );

/** What a LAN proxy needs that this host lacks, if anything. */
export const problem = (input: {
  readonly platform: string;
  readonly address: string | undefined;
  readonly mdnsInstalled: boolean;
}) => {
  const tool = MDNS_TOOLS[input.platform];
  const mdnsTool = tool !== undefined && !input.mdnsInstalled ? tool.command : undefined;
  const noAddress = input.address === undefined;
  return mdnsTool === undefined && !noAddress
    ? undefined
    : new LanUnavailable({ platform: input.platform, mdnsTool, noAddress });
};

export interface LanService {
  /**
   * Fails with everything that's missing when this host can't serve `.local`
   * names to other machines. An address pinned with `PORTLESS_LAN_IP` stands
   * in for the one found.
   */
  readonly check: (
    pinned: string | undefined,
  ) => Effect.Effect<void, LanUnavailable, ChildProcessSpawner>;
}

/** Looks at this machine's network and tools. */
export const LanLive: LanService = {
  check: Effect.fn(function* (pinned) {
    const tool = MDNS_TOOLS[Host.platform];
    const found = problem({
      platform: Host.platform,
      address: pinned ?? (yield* networkAddress),
      mdnsInstalled: tool === undefined ? true : yield* mdnsInstalled(tool),
    });
    if (found !== undefined) return yield* found;
  }),
};

/** Finds nothing missing: for tests that run a LAN proxy on a machine of their own choosing. */
export const LanNone: LanService = { check: () => Effect.void };

/** The LAN check in use. This machine's own unless a layer provides another. */
export const Lan = Context.Reference<LanService>("@alchemy.run/portless/Lan", {
  defaultValue: () => LanLive,
});

/** A layer that swaps the LAN check out. */
export const layer = (service: LanService) => Layer.succeed(Lan, service);
