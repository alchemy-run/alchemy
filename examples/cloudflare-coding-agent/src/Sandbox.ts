import * as Cloudflare from "alchemy/Cloudflare";

/** The container Claude Code runs in. Declared bare so importers stay small. */
export class Sandbox extends Cloudflare.Container<Sandbox, {}>()("Sandbox") {}
