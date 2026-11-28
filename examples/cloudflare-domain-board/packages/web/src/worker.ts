interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

/**
 * The app's Worker: the client build, plus `/api` forwarded to the board over
 * a service binding. One origin for both, so the session cookies are
 * first-party and reach every call and every live read's WebSocket.
 */
export default {
  fetch(request: Request, env: { readonly ASSETS: Fetcher; readonly BOARD: Fetcher }) {
    const { pathname } = new URL(request.url);
    return pathname.startsWith("/api") ? env.BOARD.fetch(request) : env.ASSETS.fetch(request);
  },
};
