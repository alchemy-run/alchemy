/**
 * Log-tail fixture for [Function.local.test.ts](../../Function.local.test.ts):
 * every invocation writes the `marker` query parameter to the function's
 * log group, where `alchemy logs --tail` must surface it.
 */
const handler = async (event: { queryStringParameters?: Record<string, string> }) => {
  const marker = event.queryStringParameters?.marker ?? "none";
  console.log(`tail-marker:${marker}`);
  return { statusCode: 200, headers: { "content-type": "text/plain" }, body: marker };
};

export { handler };
