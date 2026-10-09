import * as Cloudflare from "@/Cloudflare";

/** The container every mount lands in — declared bare so the DO bundle stays small. */
export class MountBox extends Cloudflare.Container<MountBox, {}>()("MountBox") {}
