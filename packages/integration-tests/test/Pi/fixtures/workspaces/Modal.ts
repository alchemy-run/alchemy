import * as AIModal from "@alchemy.run/ai/Modal";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Modal from "@alchemy.run/modal";
import * as Effect from "effect/Effect";
import { api, workspace } from "./workspace.ts";

export class PiModalWorkspace extends Cloudflare.DurableObject<PiModalWorkspace>()(
  "PiModalWorkspace",
  workspace(
    AIModal.Sandboxes(
      Effect.gen(function* () {
        const app = yield* Modal.App("PiModalApp", {});
        return yield* Modal.Image("PiModalBase", { app, image: "node:22-bookworm" });
      }),
    ),
  ),
) {}

export default class PiModalApi extends Cloudflare.Worker<PiModalApi>()(
  "PiModalApi",
  { main: import.meta.url },
  api(PiModalWorkspace),
) {}
