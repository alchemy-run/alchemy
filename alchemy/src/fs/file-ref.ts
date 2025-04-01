/**
 * Reference to a file in the filesystem
 */
export type FileRef = {
  /**
   * Type identifier for FileRef
   */
  kind: "fs::FileRef";
  /**
   * Path to the file
   */
  path: string;
};

export function isFileRef(value: unknown): value is FileRef {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "fs::FileRef"
  );
}
