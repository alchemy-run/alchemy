import * as Cloudflare from "@/Cloudflare";

/** A bundled program, scheduled by its Durable Object (so it can be snapshotted). */
export class ProgramBox extends Cloudflare.Container<ProgramBox, {}>()("ProgramBox") {}
