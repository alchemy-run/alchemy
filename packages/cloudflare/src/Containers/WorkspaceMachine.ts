/**
 * The program module of a workspace's MicroVM machines: deploy names this
 * file as the MicroVM program's `main`, and bakes the machine's config into
 * the image's environment, where it's read back here.
 *
 * NOT exported from `index.ts`.
 */
import { MACHINE_CONFIG, machineHost, type MachineConfig } from "./WorkspaceMachineHost.ts";

const config = JSON.parse(String(process.env[MACHINE_CONFIG])) as MachineConfig;

export default machineHost(config);
