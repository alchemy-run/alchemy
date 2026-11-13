import * as HttpClientRequest from "effect/http/HttpClientRequest";

/**
 * Resolves a request's relative URL against a service's origin. An absolute
 * URL is left as it is.
 */
export const resolveAgainst = (request: HttpClientRequest.HttpClientRequest, origin: string) =>
  URL.canParse(request.url)
    ? request
    : HttpClientRequest.setUrl(request, new URL(request.url, origin).toString());
