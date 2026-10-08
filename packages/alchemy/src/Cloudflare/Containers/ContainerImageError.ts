import * as Data from "effect/Data";

/** Container props declare image sources or options that cannot be combined. */
export class ContainerImageSourceConflict extends Data.TaggedError("ContainerImageSourceConflict")<{
  /** The conflicting prop names. */
  readonly options: ReadonlyArray<string>;
  readonly message: string;
}> {}

/** Embedded `image` options declare neither `ref`, `context`, nor `dockerfile`. */
export class ContainerImageSourceMissing extends Data.TaggedError("ContainerImageSourceMissing")<{
  /** The container's logical ID. */
  readonly id: string;
}> {
  override get message() {
    return `Container "${this.id}" image requires ref, context, or dockerfile`;
  }
}

/** The container's child image resource had not produced a reference when it was deployed. */
export class ContainerImageUnresolved extends Data.TaggedError("ContainerImageUnresolved")<{}> {
  override get message() {
    return "Container image resource has not resolved";
  }
}

/** Cloudflare can only deploy a published image by its manifest digest. */
export class ContainerImageDigestMissing extends Data.TaggedError("ContainerImageDigestMissing")<{
  /** The image reference that lacks a digest. */
  readonly ref: string;
}> {
  override get message() {
    return `Cloudflare containers require a published image digest, got ${this.ref}`;
  }
}
