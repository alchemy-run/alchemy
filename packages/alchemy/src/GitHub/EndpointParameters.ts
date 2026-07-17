/**
 * Octokit endpoint parameters minus what the binding injects. A plain
 * `Omit` is wrong here: `RestEndpointMethodTypes[...]["parameters"]`
 * intersects `RequestParameters`, whose string index signature makes
 * `Omit` collapse the concrete keys — this mapped type drops the index
 * signature and the injected keys while keeping every concrete field
 * (and its optionality) intact.
 */
export type EndpointParameters<
  Params,
  Injected extends PropertyKey = "owner" | "repo",
> = {
  [K in keyof Params as string extends K
    ? never
    : number extends K
      ? never
      : K extends Injected
        ? never
        : K]: Params[K];
};
