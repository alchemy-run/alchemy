import * as E2B from "@alchemy.run/e2b";
import * as Redacted from "effect/Redacted";

/** The template the binding fixture's sandboxes boot from. */
export const BindingAgent = E2B.Template("BindingAgent", {
  fromTemplate: "base",
  run: ["echo bound > /home/user/marker.txt"],
});

/** A sandbox the stack owns, reached through ConnectSandbox. */
export const BindingBox = E2B.Sandbox("BindingBox", {
  template: BindingAgent,
  timeout: "5 minutes",
  // Without auto-resume, calls into the paused sandbox fail instead of waking it.
  autoResume: false,
});

/** A volume the volume fixture reads and writes through the volume bindings. */
export const SharedVolume = E2B.Volume("SharedVolume", {});

/** A secret the fixture rotates with WriteSecret. */
export const RotatedSecret = E2B.Secret("RotatedSecret", { value: Redacted.make("first") });

/** A webhook the fixture reads delivery history from with ReadWebhook. */
export const ProbeWebhook = E2B.Webhook("ProbeWebhook", {
  url: "https://example.com/alchemy-e2b-probe",
  events: ["sandbox.lifecycle.killed"],
  // E2B requires at least 32 characters.
  signatureSecret: Redacted.make("alchemy-e2b-probe-signature-secret"),
});
