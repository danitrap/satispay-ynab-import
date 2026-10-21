# Issue tracker: GitHub

Issues and specs live in GitHub Issues for
`danitrap/satispay-ynab-import`. Use the `gh` CLI from this clone.

## Conventions

- Create issues with `gh issue create --title "..." --body-file <path>`.
- Read issues with `gh issue view <number> --json number,title,body,labels,comments`.
- List issues with `gh issue list`, using state and label filters as needed.
- Comment with `gh issue comment <number> --body-file <path>`.
- Apply or remove labels with `gh issue edit <number> --add-label "..."`
  or `--remove-label "..."`.
- Close resolved issues with `gh issue close <number> --comment "..."`.
- Link child tickets with GitHub sub-issues. If unavailable, add
  `Part of #<parent>` to the child and a task-list entry to the parent.
- Represent blockers with native issue dependencies. If unavailable,
  add `Blocked by: #<number>` to the child.

When a skill says "publish to the issue tracker", create a GitHub issue.
When it says "fetch the relevant ticket", read the referenced GitHub issue.
Use synthetic financial examples and keep credentials and real account
identifiers out of issues.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## Wayfinding

Use one issue labelled `wayfinder:map` as the map and linked sub-issues
as tickets. Label tickets `wayfinder:research`, `wayfinder:prototype`,
`wayfinder:grilling`, or `wayfinder:task`.

Select the first open, unassigned child in map order with no open blockers.
Claim it with `gh issue edit <number> --add-assignee @me`.
On completion, record the result, close the ticket, and append a brief
finding with its link to the map's Decisions-so-far.
