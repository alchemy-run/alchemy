/**
 * The entry of every host of an `AWS.Workspace`. Deploy names this file as
 * the launch template's `main` and binds the workspace's config into the
 * environment, where it's read back here.
 *
 * NOT exported from `index.ts`.
 */
import { hostTemplate } from "./WorkspaceFleet.ts";
import { HOST_CONFIG, type HostConfig } from "./WorkspaceServer.ts";

const config = JSON.parse(process.env[HOST_CONFIG] ?? "{}") as HostConfig;

export default hostTemplate(config);
