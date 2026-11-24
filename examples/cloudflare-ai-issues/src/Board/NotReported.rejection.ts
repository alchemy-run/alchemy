import * as Domain from "@alchemy.run/domain";

/** The issue was never reported to the board. */
export class NotReported extends Domain.Rejection("NotReported") {}
