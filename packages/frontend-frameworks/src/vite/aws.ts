/**
 * `@alchemy.run/frontend-frameworks/vite/aws` — the AWS deploy target for
 * the client-only Vite integration.
 *
 * A client-only Vite build is assets-only: there is no server code to
 * bundle, adapt, or post-process, so this target is a pure marker — the
 * built output deploys as-is to S3 behind CloudFront
 * (`AWS.Website.Foldkit` / `makeKvSite`).
 */
import { makeDeployTarget, type DeployTarget } from "../core/index.ts";

/** Build the AWS deploy target for a client-only Vite build. */
export const target = (config: unknown = {}): DeployTarget =>
  makeDeployTarget({ platform: "aws", config });

export default target;
