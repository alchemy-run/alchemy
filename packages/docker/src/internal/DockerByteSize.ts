// Docker's go-units RAMInBytes: a decimal magnitude with an optional
// one-space-separated b/k/m/g/t/p, kb, or KiB-style suffix.
const DOCKER_BYTE_SIZE =
  /^([+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)(?: ?(?:b|[kmgtp](?:b|ib)?)| ?)$/i;

/** Unscaled numeric magnitude, or undefined for invalid/overflowing values. */
export const parseDockerByteSizeMagnitude = (value: string): number | undefined => {
  const match = DOCKER_BYTE_SIZE.exec(value);
  if (!match) return undefined;
  const magnitude = Number(match[1]);
  return Number.isFinite(magnitude) && magnitude >= 0 ? magnitude : undefined;
};

/** Dockerfile size grammar allows zero; container shared memory does not. */
export const isDockerByteSize = (value: string): boolean =>
  parseDockerByteSizeMagnitude(value) !== undefined;
