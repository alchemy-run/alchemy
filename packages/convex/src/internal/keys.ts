/**
 * Find a key by the name it was created with. Convex stores a repeated name as
 * `<name> (<uuid>)`, so this also matches that form and takes the newest.
 */
export const findStoredKey = <K extends { name: string; creationTime: number }>(
  keys: ReadonlyArray<K>,
  name: string,
): K | undefined =>
  keys
    .filter((key) => key.name === name || key.name.startsWith(`${name} (`))
    .toSorted((a, b) => b.creationTime - a.creationTime)[0];
