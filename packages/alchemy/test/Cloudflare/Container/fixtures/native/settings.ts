import * as Effect from "effect/Effect";
import * as Cloudflare from "@/Cloudflare";
import type { NativeAsyncObject } from "./async-worker.ts";

/** Public half of a key generated once for these tests; the private key was discarded. */
export const TEST_SSH_PUBLIC_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHyBNPTu6UntBqHyD4LsYK16cRDTf2k+uD10WnuvHYoe alchemy-container-test";

export type ApplicationSettings = Pick<
  Cloudflare.Containers.DurableObjectContainerProps,
  "ssh" | "authorizedKeys" | "observability"
>;

/** A Durable Object-managed application whose application-wide settings vary per deploy. */
export const settingsStack = (settings: ApplicationSettings = {}) =>
  Effect.gen(function* () {
    const sandbox = Cloudflare.Container<NativeAsyncObject>("SANDBOX", {
      className: "NativeAsyncObject",
      schedulingPolicy: "durable_object",
      images: { shell: { image: "alpine:3.21" } },
      ...settings,
    });
    const worker = yield* Cloudflare.Worker("SettingsWorker", {
      main: `${import.meta.dirname}/async-worker.ts`,
      env: { SANDBOX: sandbox, IMAGE_REVISION: "settings" },
    });
    return { worker, application: yield* sandbox.Application };
  });

/** A container application declared under one logical id with either scheduling policy. */
export const policyStack = (policy: "default" | "durable_object") =>
  Effect.gen(function* () {
    if (policy === "default") {
      return yield* Cloudflare.Container("PolicySwitch", { image: "alpine:3.21" }).Application;
    }
    return yield* Cloudflare.Container("PolicySwitch", {
      schedulingPolicy: "durable_object",
      images: { shell: { image: "alpine:3.21" } },
    }).Application;
  });
