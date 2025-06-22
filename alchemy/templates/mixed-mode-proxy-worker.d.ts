/** biome-ignore-all lint/style/noNonNullAssertion: wrangler did it not me */
declare const _default: {
    fetch(request: Request<unknown, IncomingRequestCfProperties<unknown>>, env: Record<string, {
        fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
        connect(address: SocketAddress | string, options?: SocketOptions): Socket;
    } | DispatchNamespace>): Promise<Response>;
};
export default _default;
