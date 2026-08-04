/**
 * Shared name-mangling helpers for Prisma physical names and binding env
 * keys. Internal — not exported from the Prisma package surface.
 */

export const fnv1a64 = (value: string) => {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0").toUpperCase();
};

export const envName = (value: string) => {
  const normalized = value.replaceAll(/[^a-zA-Z0-9]/g, "_").toUpperCase();
  // Preserve the established keys for conventional PascalCase FQNs while
  // disambiguating arbitrary logical IDs whose lossy normalization can
  // collide (`db-a`, `db_a`, and `db.a`, for example).
  const canonical = value
    .split("/")
    .every((segment) => /^[A-Z][a-z0-9]*$/.test(segment));
  return canonical ? normalized : `${normalized}_${fnv1a64(value)}`;
};
