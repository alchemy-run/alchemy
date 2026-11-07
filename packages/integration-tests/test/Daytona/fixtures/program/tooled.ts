import * as Daytona from "@alchemy.run/daytona";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { InstallClient, InstallClientLive, jq, nfs } from "./capability.ts";

/** A small base: Node, for the program, and apt, for install lines. */
export const SlimNode = Daytona.Snapshot("SlimNode", { image: "node:22-bookworm-slim" });

/** A program whose binding needs `jq` in the image: a derived snapshot installs it. */
export default class Tooled extends Daytona.Sandbox<Tooled>()(
  "Tooled",
  { snapshot: SlimNode, main: import.meta.url, public: true },
  Effect.gen(function* () {
    yield* InstallClient(jq);
    return { fetch: Effect.succeed(HttpServerResponse.text("tooled")) };
  }).pipe(Effect.provide(InstallClientLive)),
) {}

/** A program whose binding needs NFS, which Daytona sandboxes don't provide. */
export class NeedsNfs extends Daytona.Sandbox<NeedsNfs>()(
  "NeedsNfs",
  { snapshot: SlimNode, main: import.meta.url },
  Effect.gen(function* () {
    yield* InstallClient(nfs);
    return { fetch: Effect.succeed(HttpServerResponse.text("nfs")) };
  }).pipe(Effect.provide(InstallClientLive)),
) {}
