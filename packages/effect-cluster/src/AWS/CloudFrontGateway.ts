import type * as Duration from "effect/Duration";

export interface CloudFrontGatewayOptions {
  /**
   * How long CloudFront waits for bytes from the gateway before it cuts a
   * call. The gateway sends a keep-alive line every 15 seconds while a call
   * waits, so a long call stays open.
   * @default "60 seconds"
   */
  readonly originReadTimeout?: Duration.Input;
  /**
   * How long CloudFront keeps an idle connection to the load balancer open.
   * @default "60 seconds"
   */
  readonly originKeepaliveTimeout?: Duration.Input;
  /**
   * The edge locations that serve the gateway.
   * @default "PriceClass_All"
   */
  readonly priceClass?: "PriceClass_100" | "PriceClass_200" | "PriceClass_All";
}

/** A CloudFront distribution in front of an internal load balancer. */
export interface CloudFrontGateway extends CloudFrontGatewayOptions {
  readonly kind: "CloudFront";
}

/**
 * Serve a pool's gateway over HTTPS on a `*.cloudfront.net` name, without a
 * domain of your own: a CloudFront distribution reaches an internal load
 * balancer through a VPC origin, so nothing on the internet reaches the
 * load balancer itself.
 *
 * ### Choosing a CloudFront gateway
 * **Example:** HTTPS without a domain
 * ```typescript
 * export const Default = ClusterAWS.EcsPool("Default", {
 *   gateway: ClusterAWS.CloudFrontGateway(),
 * }).pipe(Layer.provide(Database));
 * ```
 *
 * @primitive
 */
export const CloudFrontGateway = (options: CloudFrontGatewayOptions = {}): CloudFrontGateway => ({
  ...options,
  kind: "CloudFront",
});
