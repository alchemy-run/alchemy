import * as Domain from "@alchemy.run/domain";

/** The account belongs to someone else. */
export class NotOwner extends Domain.Rejection("NotOwner", {}, { httpApiStatus: 403 }) {}
