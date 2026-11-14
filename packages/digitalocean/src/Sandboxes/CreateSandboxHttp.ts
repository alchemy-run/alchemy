import * as Layer from "effect/Layer";
import { CreateSandbox } from "./CreateSandbox.ts";
import { makeSandboxesBinding } from "./SandboxClient.ts";

/**
 * `CreateSandbox` over the DigitalOcean MicroVM API, signed with the token
 * the binding was given.
 *
 * @layer
 * @product Sandboxes
 * @provides DigitalOcean.Sandboxes.CreateSandbox
 */
export const CreateSandboxHttp = Layer.effect(CreateSandbox, makeSandboxesBinding);
