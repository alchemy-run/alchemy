/**
 * The org's GitHub event vocabulary — the typed wire's events
 * (alchemy/GitHub) lifted into `AI.Event` terms so charters can splice
 * them. Schema and prose are one artifact, the class is the payload
 * type, and a splice narrows the process's accepted inputs to what its
 * charter declares.
 *
 * Events say what may arrive, never how — delivery (webhook vs poll,
 * dedupe, run keying) stays in the implementation Layers.
 */
import * as AI from "alchemy/AI";
import * as GitHub from "alchemy/GitHub";

export class IssueOpened extends AI.Event(
  "IssueOpened",
  GitHub.IssueOpenedEvent,
)`
An issue was opened in the repository — number, title, body, labels,
and author, as the wire delivers them.` {}

export class IssueCommented extends AI.Event(
  "IssueCommented",
  GitHub.IssueCommentedEvent,
)`
Someone commented on an issue or pull request — GitHub's one door
for both.` {}

export class IssueClosed extends AI.Event(
  "IssueClosed",
  GitHub.IssueClosedEvent,
)`
An issue was closed, by whom and however — the world's word, not
this org's.` {}

export class PullRequestOpened extends AI.Event(
  "PullRequestOpened",
  GitHub.PullRequestOpenedEvent,
)`
A pull request was opened — number, title, body, branches, author.` {}

export class PullRequestMerged extends AI.Event(
  "PullRequestMerged",
  GitHub.PullRequestMergedEvent,
)`
A pull request was merged.` {}

export class PullRequestClosed extends AI.Event(
  "PullRequestClosed",
  GitHub.PullRequestClosedEvent,
)`
A pull request was closed without merging.` {}
