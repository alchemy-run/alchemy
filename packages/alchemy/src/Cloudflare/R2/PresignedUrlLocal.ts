/**
 * Local (`alchemy dev`) implementation of {@link PresignedUrl}.
 *
 * In dev mode the host is `alchemy dev`'s workerd simulator. The
 * Worker-binding path applies unchanged — the simulator surfaces
 * `secret_text` bindings the same way production does. We re-use
 * the Worker-binding Layer directly.
 */

export {
  PresignedUrlBinding as PresignedUrlLocal,
  runtimePresignedUrlClientFromEnv,
} from "./PresignedUrlBinding.ts";
