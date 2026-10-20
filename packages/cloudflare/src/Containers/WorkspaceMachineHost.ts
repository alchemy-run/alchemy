/**
 * The sandbox host of a workspace's MicroVM machines: the same Layer at
 * deploy (it builds the image) and inside the MicroVM (it serves the
 * program). The program is nothing but a health check: commands arrive
 * through the sandbox's `exec`, and the disk through `blockd mount`.
 *
 * NOT exported from `index.ts`.
 */
import type { MicrovmSandboxMemory } from "@alchemy.run/aws/Lambda/MicrovmSandbox";
import { MicrovmSandbox } from "@alchemy.run/aws/Lambda/MicrovmSandbox";
import type * as microvms from "@distilled.cloud/aws/lambda-microvms";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { machineSandbox } from "./WorkspaceNames.ts";

/** The env var a MicroVM machine's image carries its {@link MachineConfig} in. */
export const MACHINE_CONFIG = "ALCHEMY_WORKSPACE_MACHINE";

/** What a MicroVM machine is built from, the same at deploy and inside it. */
export interface MachineConfig {
  readonly id: string;
  readonly memory: MicrovmSandboxMemory;
  readonly cpuConfigurations?: microvms.CpuConfiguration[];
}

export const machineHost = (
  config: MachineConfig,
  deploy?: { readonly main: string; readonly dockerfile: string },
) =>
  MicrovmSandbox(
    machineSandbox(config.id),
    {
      main: deploy?.main ?? "",
      sizes: { machine: config.memory },
      ...(deploy ? { dockerfile: deploy.dockerfile } : {}),
      // A machine mounts its disk (a FUSE file on a loop device).
      additionalOsCapabilities: ["ALL"],
      env: { [MACHINE_CONFIG]: JSON.stringify(config) },
      ...(config.cpuConfigurations ? { cpuConfigurations: config.cpuConfigurations } : {}),
    },
    Effect.succeed({
      fetch: Effect.succeed(HttpServerResponse.text("workspace machine\n")),
    }) as never,
  );
