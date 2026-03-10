# .pakalon-agents

This directory contains all Pakalon agentic execution artifacts.

## Structure

```
.pakalon-agents/
├── ai-agents/
│   ├── sync.js                   # Penpot sync bridge launcher (lifecycle owner)
│   ├── phase-1/
│   │   ├── plan.md               # Full project plan
│   │   ├── tasks.md              # Phase-split task list
│   │   ├── design.md             # UI/UX design brief
│   │   ├── API_reference.md      # ← used by Phase-3 SA-2 (backend)
│   │   ├── Database_schema.md    # ← used by Phase-3 SA-2 (backend)
│   │   ├── prd.md                # Product Requirements Document
│   │   ├── user-stories.md       # Acceptance-criteria user stories
│   │   ├── agent-skills.md       # Agent skill registry
│   │   ├── risk-assessment.md
│   │   ├── technical-spec.md
│   │   ├── competitive-analysis.md
│   │   ├── constraints-and-tradeoffs.md
│   │   ├── context_management.md
│   │   └── phase-1.md            # Consolidated phase summary
│   ├── phase-2/
│   │   ├── Wireframe_generated.svg
│   │   ├── Wireframe_generated.penpot
│   │   ├── phase-2.md
│   │   └── tdd-screenshots/      # TDD screenshot evidence
│   ├── phase-3/
│   │   ├── subagent-1.md  subagent-2.md  subagent-3.md
│   │   ├── subagent-4.md  subagent-5.md
│   │   ├── execution_log.md      # Full audit log (read by SA-5)
│   │   └── test-evidence/
│   ├── phase-4/
│   │   ├── subagent-1.md … subagent-5.md
│   │   ├── blackbox_testing.xml  # User-story perspective tests
│   │   └── whitebox_testing.xml  # Internal structure tests
│   ├── phase-5/
│   │   └── phase-5.md
│   └── phase-6/
│       └── phase-6.md
├── wireframes/    # Timestamped wireframe exports (SVG + .penpot)
├── mcp-servers/   # Project-scoped MCP server configs
├── test-evidence/ # Top-level test artefacts
├── decisions/     # Cross-phase decision registry
└── pakalon.db     # Local SQLite agent state
```

## Penpot / Design Sync

Run the Penpot sync bridge from the project root:

```bash
# Preferred: lifecycle mode (auto start/stop sync when Penpot opens/closes)
node .pakalon-agents/ai-agents/sync.js --lifecycle --file <penpot-file-id>

# Or via the CLI command:
pakalon /penpot
```
