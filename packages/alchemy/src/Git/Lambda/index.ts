/**
 * `alchemy/Git/Lambda` — the pack hasher on AWS Lambda (DESIGN §22.11).
 * A separate entry from `alchemy/Git` so a Git Worker that hashes inline
 * never bundles the Lambda provider.
 */
export { default as HasherFunction } from "./HasherFunction.ts";
export { HasherLambda } from "./HasherLambda.ts";
export {
  boundScan,
  decodeHashResponse,
  encodeHashEvent,
  handleHashEvent,
  isHashEvent,
  LAMBDA_CHUNK_BYTES,
  RESPONSE_BUDGET_BYTES,
  type HashEvent,
  type HashResponse,
} from "./HashEvent.ts";
