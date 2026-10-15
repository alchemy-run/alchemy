import * as Domain from "alchemy/Domain";

/** The actor does not own the account. */
export class NotOwner extends Domain.Rejection("NotOwner") {}
