import * as S3 from "alchemy-effect/aws/s3";

export class FilesBucket extends S3.Bucket("Files", {
  forceDestroy: true,
  tags: {
    Purpose: "example",
  },
}) {}
