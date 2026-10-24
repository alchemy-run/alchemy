import * as Cloudflare from "@alchemy.run/cloudflare";

/** The box every session runs in — declared bare so the DO bundle stays small. */
export class Sandbox extends Cloudflare.Container<Sandbox, {}>()("HarnessSandbox") {}
