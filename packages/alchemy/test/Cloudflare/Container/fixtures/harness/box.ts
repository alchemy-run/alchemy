import * as Cloudflare from "@/Cloudflare";

/** A container serving Claude Code, kept working across restarts by its Durable Object. */
export class HarnessBox extends Cloudflare.Container<HarnessBox, {}>()("HarnessBox") {}
