export async function handler(event: any) {
  console.log("Received event:", JSON.stringify(event));

  // For Lambda URL, the actual payload is in the body
  const payload = event.body
    ? typeof event.body === "string"
      ? JSON.parse(event.body)
      : event.body
    : event;

  return {
    statusCode: 200,
    body: JSON.stringify({
      message: "Hello from bundled handler!",
      event: payload,
    }),
  };
}
// test case for handlers with _, 0-9, and A-Z
export const _myHandler012 = handler;
