// A plain async Lambda handler exported only as `handler` (no default
// export), deployed without `handler`/`isExternal` set — the documented
// async-handler shape.
export const handler = async () => ({ statusCode: 200, body: "ok" });
