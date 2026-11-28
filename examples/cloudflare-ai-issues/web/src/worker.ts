interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

/**
 * The app's Worker: the client build, plus `/api` and `/sessions` forwarded
 * to the board over a service binding, so the app and the board share one
 * origin.
 */
export default {
  fetch(request: Request, env: { readonly ASSETS: Fetcher; readonly BOARD: Fetcher }) {
    const { pathname } = new URL(request.url);
    return pathname.startsWith("/api") || pathname.startsWith("/sessions/")
      ? env.BOARD.fetch(request)
      : env.ASSETS.fetch(request);
  },
};
