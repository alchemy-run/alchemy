import * as Cloudflare from "@alchemy.run/cloudflare";

const context = `${import.meta.dirname}/context`;

/** #3320: a relative `dockerfile` resolves against `context`. */
export class ContextRelative extends Cloudflare.Container<ContextRelative>()(
  "DockerfileContextRelative",
  { context, dockerfile: "Dockerfile.api" },
) {}

/** An absolute `dockerfile` is used as-is. */
export class AbsolutePath extends Cloudflare.Container<AbsolutePath>()("DockerfileAbsolutePath", {
  context,
  dockerfile: `${context}/Dockerfile.api`,
}) {}
