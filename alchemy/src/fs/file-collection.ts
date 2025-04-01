/**
 * Collection of files with their contents
 */
export type FileCollection = {
  /**
   * Type identifier for FileCollection
   */
  type: "fs::FileCollection";
  /**
   * Map of relative paths to file contents
   */
  files: {
    [relativePath: string]: string;
  };
};

export function isFileCollection(value: unknown): value is FileCollection {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "fs::FileCollection"
  );
}
