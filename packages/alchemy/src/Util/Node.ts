export const isTransformTypesSupported = (
  version = process.versions.node,
): boolean => {
  const [major, minor] = version.split(".").map(Number);
  return (major === 22 && minor >= 7) || (major >= 23 && major < 26);
};

/**
 * Node CLI flags that transparently transform TypeScript types so `.ts`
 * entry points work the same way they do under Bun. Empty when the running
 * Node doesn't support (or no longer needs) the experimental flag.
 */
export const transformTypesFlags = (): string[] =>
  isTransformTypesSupported()
    ? ["--experimental-transform-types", "--no-warnings=ExperimentalWarning"]
    : [];
