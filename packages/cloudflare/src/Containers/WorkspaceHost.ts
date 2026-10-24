/**
 * The host Worker of a `Cloudflare.Containers.Workspace`: its entry module.
 * Deploy names this file as the Worker's `main` and binds the workspace's
 * config into its environment, where it's read back here.
 *
 * NOT exported from `index.ts`.
 */
import { env } from "cloudflare:workers";
import { HOST_CONFIG, hostWorker, type HostConfig } from "./WorkspaceObjects.ts";

const config = JSON.parse(String((env as Record<string, unknown>)[HOST_CONFIG])) as HostConfig;

export default hostWorker(config);
