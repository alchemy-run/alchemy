/** What an issue's agent is sent, as text. The page reads the same shapes back out of a transcript. */
export const STARTED = "The issue is ";
export const REPLIED = "A reply on the issue: ";

export const started = (issue: string) => `${STARTED}${issue}.`;
export const replied = (body: string) => `${REPLIED}${body}`;
