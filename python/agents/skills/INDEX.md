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

---

## Skills Loading

Skills are automatically loaded based on project type:

1. **Frontend projects**: Load `frontend-design`, `react-best-practices`, `web-design-guidelines`
2. **Backend projects**: Load appropriate backend patterns
3. **Full-stack projects**: Load all relevant skills

The skills are referenced in:
- `.pakalon/agents/skills.md` (normal mode)
- `.pakalon-agents/ai-agents/phase-1/` (agent mode)
- Phase 3 subagent prompts

---

## Usage

When creating UI components or web interfaces, the AI should:

1. Reference the `frontend-design.md` skill for aesthetic guidance
2. Follow `react-best-practices.md` for React implementation
3. Use `web-design-guidelines.md` for compliance checking

---

*This index is auto-generated and updated with Pakalon.*
