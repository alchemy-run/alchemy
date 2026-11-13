import * as Cloudflare from "@alchemy.run/cloudflare";
import * as pathe from "pathe";

const context = `${import.meta.dirname}/context`;

/** #3320: a relative `dockerfile` resolves against `context`. */
export class ContextRelative extends Cloudflare.Container<ContextRelative>()(
  "DockerfileContextRelative",
  { context, dockerfile: "Dockerfile.api" },
) {}

/** Stacks written before #3320 pass a path relative to the working directory. */
export class CwdRelative extends Cloudflare.Container<CwdRelative>()("DockerfileCwdRelative", {
  context,
  dockerfile: pathe.relative(process.cwd(), `${context}/Dockerfile.api`),
}) {}
