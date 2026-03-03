/**
 * Memory file loader — loads .pakalon/PAKALON.md or CLAUDE.md at session start.
 *
 * T-A17: Implement PAKALON.md / CLAUDE.md memory file loading at session start
 *
 * This follows Claude Code's convention of loading project-specific instructions
 * from either .pakalon/PAKALON.md or .pakalon/CLAUDE.md (or .claude.md at root).
 *
 * The content is injected as a <pakalon-memory> block in the system prompt.
 */

import fs from "fs";
import path from "path";
import logger from "@/utils/logger.js";

const MEMORY_FILENAMES = [
	"PAKALON.md",
	"CLAUDE.md",
	"claude.md",
];

/**
 * Find and load the memory file from the project directory.
 * Searches in order: .pakalon/PAKALON.md, .pakalon/CLAUDE.md, ./claude.md
 *
 * @param projectDir - The project directory to search in
 * @returns The memory file content, or null if not found
 */
export function loadMemoryFile(projectDir: string): string | null {
	const searchPaths = [
		// .pakalon/PAKALON.md
		path.join(projectDir, ".pakalon", "PAKALON.md"),
		// .pakalon/CLAUDE.md
		path.join(projectDir, ".pakalon", "CLAUDE.md"),
		// ./claude.md (root level, like Claude Code)
		path.join(projectDir, "claude.md"),
	];

	for (const memoryPath of searchPaths) {
		try {
			if (fs.existsSync(memoryPath)) {
				const content = fs.readFileSync(memoryPath, "utf-8").trim();
				if (content) {
					logger.debug(`[memory] Loaded memory file: ${memoryPath}`);
					return content;
				}
			}
		} catch (err) {
			logger.warn(`[memory] Failed to read ${memoryPath}`, { error: String(err) });
		}
	}

	return null;
}

/**
 * Build a memory block for injection into the system prompt.
 *
 * @param projectDir - The project directory
 * @returns Formatted memory block, or empty string if no memory file found
 */
export function buildMemoryBlock(projectDir: string): string {
	const memory = loadMemoryFile(projectDir);
	if (!memory) {
		return "";
	}

	return `<pakalon-memory>
${memory}
</pakalon-memory>`;
}

/**
 * Reload memory file on demand (for /reload command).
 *
 * @param projectDir - The project directory
 * @returns The new memory content, or null if not found
 */
export function reloadMemoryFile(projectDir: string): string | null {
	logger.debug("[memory] Reloading memory file");
	return loadMemoryFile(projectDir);
}
