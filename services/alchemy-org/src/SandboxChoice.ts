/**
 * WHICH machine each session gets — the org's one sandbox switch,
 * HARDCODED (edit this line to flip; it's a build-time choice that
 * selects layers and deployed resources, not runtime config):
 *
 * - `container` — a Cloudflare Container attached to the session's
 *   Durable Object;
 * - `microvm` — an AWS Lambda MicroVM (Firecracker) launched from the
 *   shared image, driven cross-cloud from the org Worker via the
 *   minted IAM-user + assume-role credentials. Requires an account
 *   onboarded to the Lambda MicroVM preview + `alchemy aws bootstrap`.
 *
 * A LEAF module: the Worker, the driver assembly, and the stack all
 * read it, so it must import nothing of theirs.
 */
export const SANDBOX: "container" | "microvm" = "container";
