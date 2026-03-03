/**
 * /plan command — generate a plan into output.md
 * /build command — implement the plan from output.md
 */
import fs from "fs";
import path from "path";
import { debugLog } from "@/utils/logger.js";

/**
 * Generate a plan from user context.
 * Returns the plan content for streaming into output.md.
 */
export function getPlanPrompt(userContext: string): string {
  return `Create a comprehensive, detailed implementation plan for the following project/task:

${userContext}

Your plan MUST include:
1. **Project Overview** — clear description of what will be built
2. **Tech Stack** — specific versions of every tool, library, framework
3. **Architecture** — component diagram (ASCII), data flow, key design decisions
4. **File Structure** — exact directory tree with all files to be created
5. **Implementation Phases** — ordered list of specific, actionable tasks
6. **API Contracts** — any REST/GraphQL endpoints needed
7. **Database Schema** — tables/collections with field types
8. **Testing Strategy** — unit, integration, E2E test plan
9. **Deployment** — infrastructure and CI/CD requirements
10. **Open Questions** — any ambiguities that need clarification

Be specific and complete. This plan will be directly implemented by an AI agent.`;
}

/**
 * Get the path for plan output file in cwd.
 */
export function getPlanOutputPath(cwd: string = process.cwd()): string {
  return path.join(cwd, "output.md");
}

/**
 * Check if a plan exists in cwd.
 */
export function planExists(cwd: string = process.cwd()): boolean {
  return fs.existsSync(getPlanOutputPath(cwd));
}

/**
 * Read the plan from output.md.
 */
export function readPlan(cwd: string = process.cwd()): string | null {
  const planPath = getPlanOutputPath(cwd);
  if (!fs.existsSync(planPath)) return null;
  return fs.readFileSync(planPath, "utf-8");
}

/**
 * Write plan content to output.md.
 */
export function writePlan(content: string, cwd: string = process.cwd()): void {
  const planPath = getPlanOutputPath(cwd);
  fs.writeFileSync(planPath, content, "utf-8");
  debugLog(`[plan] Written to ${planPath}`);
}

/**
 * Get the implementation prompt from an existing plan.
 */
export function getBuildPrompt(cwd: string = process.cwd()): string {
  const plan = readPlan(cwd);
  if (!plan) throw new Error("No plan found. Run /plan first.");

  return `Implement the following plan completely and correctly. Follow every specification exactly.

${plan}

Instructions:
- Create ALL files listed in the file structure
- Implement ALL phases in the specified order
- Use the exact tech stack versions specified
- Match the database schema exactly
- Implement all API endpoints specified
- Write tests as specified in the testing strategy
- Use auto-accept mode — proceed without asking for confirmations
- After each major phase, confirm it is working before proceeding`;
}

/**
 * Check if a .pakalon/ directory exists for context.
 */
export function getPakalonContext(cwd: string = process.cwd()): string | null {
  const pakalonDir = path.join(cwd, ".pakalon");
  if (!fs.existsSync(pakalonDir)) return null;

  const contextFiles = ["plan.md", "tasks.md", "user-stories.md"];
  const parts: string[] = [];

  for (const file of contextFiles) {
    const filePath = path.join(pakalonDir, file);
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, "utf-8").trim();
      if (content) {
        parts.push(`### ${file}\n${content}`);
      }
    }
  }

  return parts.length > 0 ? parts.join("\n\n") : null;
}
