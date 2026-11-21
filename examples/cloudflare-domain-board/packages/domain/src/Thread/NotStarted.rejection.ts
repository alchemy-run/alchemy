import * as Domain from "@alchemy.run/domain";

/** No thread has been started with this id. */
export class NotStarted extends Domain.Rejection(
  "NotStarted",
  {},
  { httpApiStatus: 404, description: "No thread has been started with this id." },
) {}
