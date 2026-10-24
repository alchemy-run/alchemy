/**
 * Constants shared by `AWS.Lambda.MicrovmSandbox` (the host, at deploy) and
 * its Durable Object client (at run time). Free of AWS imports: the
 * Cloudflare Durable Object platform reads {@link MICROVM_SANDBOX_HOST} to
 * decide whether to load the client at all.
 */

/** The `Sandbox.SandboxHostDescriptor.host` of an AWS Lambda MicroVM sandbox host. */
export const MICROVM_SANDBOX_HOST = "AWS.Lambda.MicrovmSandbox";

/** The port the sandbox's program listens on unless `port` says otherwise. */
export const MICROVM_SANDBOX_PORT = 3000;

/**
 * The port of the in-VM egress control endpoint: `PUT /routes` (bearer
 * secret) and the MicroVM lifecycle hooks (`hooks.port`).
 */
export const MICROVM_SANDBOX_CONTROL_PORT = 3129;

/** The logical id of the image built for one declared size. */
export const microvmSandboxImageId = (id: string, size: string) => `${id}-${size}`;
