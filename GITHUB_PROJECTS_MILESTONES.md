# GitHub Projects & Milestones - Implementation Notes

This document outlines the patterns for implementing GitHub Projects (v2) and Milestones resources in alchemy.

## WikiPage (✅ Shipped)

Implemented in PR #4 following all alchemy patterns:
- Reconcile doctrine (observe-ensure-sync)
- Proper diff/stables/list/delete
- Default retain policy
- Test coverage

## Milestone (Recommended Next)

Milestones are straightforward CRUD resources similar to existing alchemy patterns.

### API Coverage

GitHub REST API: `/repos/{owner}/{repo}/milestones`

**Operations:**
- `GET /repos/{owner}/{repo}/milestones` - list
- `GET /repos/{owner}/{repo}/milestones/{milestone_number}` - get
- `POST /repos/{owner}/{repo}/milestones` - create
- `PATCH /repos/{owner}/{repo}/milestones/{milestone_number}` - update
- `DELETE /repos/{owner}/{repo}/milestones/{milestone_number}` - delete

### Resource Shape

```typescript
export interface MilestoneProps {
  owner: string;
  repository: string;
  title: string;
  state?: "open" | "closed";
  description?: string;
  dueOn?: string; // ISO-8601 date
  baseUrl?: string;
}

export interface Milestone extends Resource<
  "GitHub.Milestone",
  MilestoneProps,
  {
    milestoneNumber: number;
    title: string;
    state: "open" | "closed";
    description: string | null;
    dueOn: string | null;
    htmlUrl: string;
    createdAt: string;
    updatedAt: string;
    openIssues: number;
    closedIssues: number;
  }
> {}
```

### Implementation Pattern

- **Stables:** `milestoneNumber`
- **Diff:** Replace on `owner`, `repository`, `title`, or `baseUrl` change
- **Reconcile:** Observe by title → ensure create → sync state/description/dueOn
- **List:** Enumerate via `octokit.paginate(listForAuthenticatedUser)` then per-repo milestones
- **Delete:** Standard idempotent delete with 404 tolerance

### File Locations

- `packages/alchemy/src/GitHub/Milestone.ts`
- `packages/alchemy/test/GitHub/Milestone.test.ts`
- Update `packages/alchemy/src/GitHub/index.ts`
- Update `packages/alchemy/src/GitHub/Providers.ts`

### Test Coverage

1. Create milestone with basic properties
2. Update milestone (change description, state, due date)
3. Close and reopen milestone
4. Replace on title change
5. Wire with Repository resource

## Projects v2 (Complex - Document as Follow-up)

GitHub Projects v2 uses GraphQL and has significant complexity:

### Challenges

1. **GraphQL-only API** - No REST API coverage
   - Would require GraphQL client integration (currently alchemy uses REST via Octokit)
   - GraphQL mutations for create/update/delete
   - GraphQL queries for read/list

2. **Complex Resource Model**
   - Project (container)
   - ProjectV2Field (custom fields: text, number, date, single select, iteration)
   - ProjectV2Item (links issues/PRs to project)
   - ProjectV2ItemFieldValue (field values per item)
   - ProjectV2View (saved views/filters)
   - ProjectV2Workflow (automation rules)

3. **Unclear Reconciliation Surface**
   - Fields are created separately from the project
   - Items reference external issues/PRs (cross-resource dependencies)
   - Field values are per-item, not per-project
   - Views and workflows are complex sub-resources

4. **Scope Ambiguity**
   - Projects can be org-level OR user-level OR repo-level
   - Different APIs for different scopes
   - Permissions vary by scope

### Recommendation

**Document Projects v2 as out-of-scope for now** due to:
- GraphQL-only API (architectural mismatch with current Octokit-based resources)
- Complex multi-resource model unclear how to express as single Resource
- Unclear convergence semantics (when does an item "belong" to a project?)

Alternative approach if needed:
- Implement basic Project CRUD only (no fields/items/workflows)
- Use Octokit's GraphQL support: `octokit.graphql(...)`
- Mark as experimental/beta
- Document limitations clearly

### If Implementing

Start with minimal surface:

```typescript
export interface ProjectProps {
  owner: string; // user or org
  title: string;
  shortDescription?: string;
  readme?: string;
  public?: boolean;
  baseUrl?: string;
}

// Leave fields, items, workflows as separate resources or out-of-scope
```

Use GraphQL mutations:
- `createProjectV2`
- `updateProjectV2`
- `deleteProjectV2`

## Implementation Order

1. ✅ **WikiPage** - Shipped in PR #4
2. 🎯 **Milestone** - Clean, straightforward, follows patterns
3. 📝 **Projects v2** - Document complexity, mark as future work

## Related Resources

Consider these GitHub resources as well:
- **Label** - Simple CRUD for issue/PR labels
- **Team** - Org-level teams (may need org scope resolution)
- **BranchProtection** - Ruleset for branch protection
- **Release** - GitHub releases (tags + artifacts)

Each follows similar patterns to existing resources.
