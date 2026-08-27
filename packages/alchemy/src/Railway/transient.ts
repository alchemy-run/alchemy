/**
 * Railway API errors that are safe to retry: throttles plus gateway
 * disconnects (`ServiceUnavailable` "upstream connect error", 502, 504).
 */
export const isRailwayTransient = (e: {
  _tag: string;
  message?: string;
}): boolean =>
  e._tag === "RailwayRateLimited" ||
  e._tag === "TooManyRequests" ||
  e._tag === "ServiceUnavailable" ||
  e._tag === "BadGateway" ||
  e._tag === "GatewayTimeout" ||
  (e._tag === "RailwayInternalError" &&
    typeof e.message === "string" &&
    e.message.includes("creating volumes too quickly"));
