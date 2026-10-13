/**
 * Listen-address shim for `AWS.Lambda.WebFunction`. Lambda chooses the
 * address the server must bind and passes it as `AWS_LAMBDA_HTTP_ENDPOINT`
 * (`host:port`). Most Node servers read `PORT` / `HOST` (Next.js standalone
 * reads `HOSTNAME`, nitro reads `NITRO_PORT` / `NITRO_HOST`), so importing
 * this module first mirrors the Lambda address into those variables before
 * the user's server module evaluates.
 *
 * The generated async entry imports {@link listenAddress} ahead of `main`;
 * ES modules evaluate in import order, so a server that listens at module
 * top level already sees the mirrored values.
 */

export interface LambdaHttpEndpoint {
  readonly host: string;
  readonly port: number;
}

/**
 * The address Lambda routes requests to, or the local fallback
 * (`127.0.0.1:3000`) when `AWS_LAMBDA_HTTP_ENDPOINT` is unset.
 */
export const lambdaHttpEndpoint = (): LambdaHttpEndpoint => {
  const value = process.env.AWS_LAMBDA_HTTP_ENDPOINT;
  const separator = value?.lastIndexOf(":") ?? -1;
  if (value === undefined || separator <= 0) {
    return {
      host: process.env.HOST ?? "127.0.0.1",
      port: Number(process.env.PORT ?? 3000),
    };
  }
  return {
    host: value.slice(0, separator).replace(/^\[(.*)\]$/, "$1"),
    port: Number(value.slice(separator + 1)),
  };
};

/**
 * Mirror the Lambda address into the conventional listen variables and
 * return it.
 */
const mirrorLambdaHttpEndpoint = (): LambdaHttpEndpoint => {
  const endpoint = lambdaHttpEndpoint();
  if (process.env.AWS_LAMBDA_HTTP_ENDPOINT !== undefined) {
    process.env.PORT = String(endpoint.port);
    process.env.HOST = endpoint.host;
    process.env.HOSTNAME = endpoint.host;
    process.env.NITRO_PORT = String(endpoint.port);
    process.env.NITRO_HOST = endpoint.host;
  }
  return endpoint;
};

/**
 * The listen address, mirrored into the environment when this module
 * evaluates. The generated entry consumes this export: alchemy is bundled
 * as side-effect free, so a bare `import` of this module would be dropped.
 */
export const listenAddress: LambdaHttpEndpoint = mirrorLambdaHttpEndpoint();
