# Web Design Guidelines Skill

This skill reviews UI code for Web Interface Guidelines compliance.

---

## Overview

**Name:** web-design-guidelines

**Description:** Review UI code for Web Interface Guidelines compliance. Use when asked to "review my UI", "check accessibility", "audit design", "review UX", or "check my site against best practices".

**When to use:**
- UI code review
- Accessibility audits
- UX evaluation
- Design compliance checking

---

## Input

User provides:
- Files or patterns to review
- Optional: specific guidelines or standards to check against

---

## How It Works

1. Fetch the latest guidelines from the source URL below
2. Read the specified files (or prompt user for files/pattern)
3. Check against all rules in the fetched guidelines
4. Output findings in the terse `file:line` format

---

## Guidelines Source

Fetch fresh guidelines before each review:

```
https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md
```

Use WebFetch to retrieve the latest rules. The fetched content contains all the rules and output format instructions.

---

## Usage

When a user provides a file or pattern argument:

1. Fetch guidelines from the source URL above
2. Read the specified files
3. Apply all rules from the fetched guidelines
4. Output findings using the format specified in the guidelines

If no files specified, ask the user which files to review.

---

## Output Format

Follow the format specified in the fetched guidelines document. Typically:
- `file:line:message` format
- Group by severity (error, warning, suggestion)
- Include relevant code snippets where helpful

---

## Scope

This skill focuses on:
- Accessibility (WCAG compliance)
- Performance best practices
- Responsive design patterns
- User experience patterns
- Design system consistency
- Browser compatibility

---

## Related Skills

- **frontend-design**: For creating new interfaces
- **react-best-practices**: For React-specific guidelines

---

*This skill is used during Phase 4 (Security & QA) for design reviews.*
