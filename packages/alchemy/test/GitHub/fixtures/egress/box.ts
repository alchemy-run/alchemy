import * as Cloudflare from "@/Cloudflare";

/** A shell for `gh` and `git`, with GitHub access only through its Durable Object's egress. */
export class EgressBox extends Cloudflare.Container<EgressBox, {}>()("GitHubEgressBox") {}
