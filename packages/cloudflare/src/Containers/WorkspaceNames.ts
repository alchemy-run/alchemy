/**
 * Names shared by a workspace's host Worker and its MicroVM machines'
 * image: kept apart so neither bundle pulls in the other's runtime.
 *
 * NOT exported from `index.ts`.
 */
import { Sandbox } from "@alchemy.run/sandbox/Sandbox";

/** Durable Object classes and declarations are named for the workspace. */
export const className = (id: string, kind: string) =>
  `${id.replace(/[^A-Za-z0-9_$]/g, "_")}${kind}`;

/** @internal A machine on a sandbox host other than Cloudflare's (a Lambda MicroVM). */
export const machineSandbox = (id: string) =>
  Sandbox<any, { size: "machine" }>()(className(id, "Vm"));
