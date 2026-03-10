# Agent Skills Index

This file provides an index of all available agent skills for Pakalon. These skills guide the AI in creating high-quality code across different domains.

---

## Available Skills

### 1. Frontend Design

**File:** `frontend-design.md`

Create distinctive, production-grade frontend interfaces with high design quality. Use this skill when building web components, pages, or applications.

**Key Principles:**
- Choose bold aesthetic directions
- Use distinctive typography
- Commit to cohesive color themes
- Add meaningful motion and animations
- Create unexpected spatial compositions

### 2. Web Design Guidelines

**File:** `web-design-guidelines.md`

Review UI code for Web Interface Guidelines compliance. Used during Phase 4 for design audits and accessibility checks.

### 3. React Best Practices

**File:** `react-best-practices.md`

Apply React best practices for component architecture, state management, performance optimization, and modern hooks usage.

### 4. Composition Patterns

**File:** `composition-patterns.md`

Advanced composition patterns for building flexible, reusable components. Covers compound components, render props, and higher-order components.

### 5. React Native Guidelines

**File:** `react-native-skills.md`

React Native best practices for mobile application development covering navigation, performance, and platform-specific patterns.

---

## Document Skills

### 6. Docx

**File:** `docx.md`  *(T-RAG-09 — Anthropic)*

Create, edit and modify `.docx` Word documents with formatting, tables, images, headers/footers, and track-changes.

### 7. PDF

**File:** `pdf.md`  *(T-RAG-10 — Anthropic)*

Read, extract, merge, split, create, watermark, fill AcroForms, and OCR-scan PDF files.

### 8. PPTX

**File:** `pptx.md`  *(T-RAG-11 — Anthropic)*

Create and modify PowerPoint presentations with slides, layouts, speaker notes, charts and transitions.

### 9. XLSX

**File:** `xlsx.md`  *(T-RAG-12 — Anthropic)*

Create and modify Excel workbooks with formulas, charts, pivot tables, conditional formatting and data validation.

---

## Infrastructure Skills

### 10. MCP Builder

**File:** `mcp-builder.md`  *(T-RAG-13 — Anthropic)*

Generate fully functional Model Context Protocol servers from natural language specifications or OpenAPI definitions. Covers Python/stdio and SSE transports.

### 11. Vercel Deploy Claimable

**File:** `vercel-deploy-claimable.md`  *(T-RAG-20 — Vercel)*

Deploy applications to Vercel with claimable preview URLs, project creation, environment variable management, and deployment status polling.

---

## Testing Skills

### 12. Webapp Testing

**File:** `webapp-testing.md`  *(T-RAG-14 — Anthropic)*

Write, run, and interpret browser-based end-to-end, visual regression, and accessibility tests using Playwright and the Agent Browser TDD loop.

---

## Skills Loading

Skills are automatically loaded based on project type:

1. **Frontend projects**: Load `frontend-design`, `react-best-practices`, `web-design-guidelines`, `webapp-testing`
2. **Mobile projects**: Load `react-native-guidelines`
3. **Document generation**: Load `docx`, `pdf`, `pptx`, `xlsx`
4. **Deployment tasks**: Load `vercel-deploy-claimable`
5. **MCP server projects**: Load `mcp-builder`
6. **Full-stack projects**: Load all relevant skills

The skills are referenced in:
- `.pakalon/agents/skills.md` (normal mode)
- `.pakalon-agents/ai-agents/phase-1/` (agent mode)
- Phase 3 subagent prompts

---

## Dynamic GitHub Skills (T-RAG-06)

Remote skills are fetched at runtime from configured GitHub repositories and cached for 24 hours:

- `ui-ux-pro-max` — from `nextlevelbuilder/ui-ux-pro-max-skill`
- `vercel-agent-skills` — from `vercel-labs/agent-skills`
- `shadcn-components` — from `shadcn-ui/ui`

---

*This index is auto-generated and updated with Pakalon.*
