import * as Data from "effect/Data";

/** Image or remote-image props combine options that cannot be used together. */
export class DockerImageOptionsConflict extends Data.TaggedError("DockerImageOptionsConflict")<{
  /** The conflicting option names. */
  readonly options: ReadonlyArray<string>;
  readonly message: string;
}> {}

/** Build inputs combine a generated context with a filesystem context, or vice versa. */
export class DockerBuildInputConflict extends Data.TaggedError("DockerBuildInputConflict")<{
  readonly message: string;
}> {}

/** An inline Dockerfile still holds an unresolved Output when the image is prepared. */
export class DockerBuildInputUnresolved extends Data.TaggedError("DockerBuildInputUnresolved")<{
  readonly message: string;
}> {}

/** A generated build-context file path escapes the context or collides with another file. */
export class DockerGeneratedFileInvalid extends Data.TaggedError("DockerGeneratedFileInvalid")<{
  /** The rejected `build.files[].path`. */
  readonly path: string;
}> {
  override get message() {
    return `Invalid generated image path: ${this.path}`;
  }
}

/** A just-published image could not be observed in its registry. */
export class DockerPublishedImageMissing extends Data.TaggedError("DockerPublishedImageMissing")<{
  /** The input-hash reference that was published. */
  readonly reference: string;
}> {
  override get message() {
    return `Published image ${this.reference} is missing from the registry`;
  }
}
