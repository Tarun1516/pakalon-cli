import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { todoReadTool, todoWriteTool } from "../tools.js";

const originalCwd = process.cwd();

function toolExecute<TInput extends Record<string, unknown>>(toolDef: unknown, input: TInput): Promise<any> {
  const execute = (toolDef as { execute?: (args: TInput) => Promise<unknown> }).execute;
  if (!execute) {
    throw new Error("Tool definition is missing execute()");
  }
  return execute(input);
}

describe("todo tools", () => {
  let tempDir = "";

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pakalon-todo-tools-"));
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("accepts the action alias used by planner outputs", async () => {
    const addResult = await toolExecute(todoWriteTool, {
      action: "add",
      content: "Add a heart emoji in README",
    });

    expect(addResult.success).toBe(true);

    const readResult = await toolExecute(todoReadTool, {
      statusFilter: "all",
    });

    expect(readResult.total).toBe(1);
    expect(readResult.todos[0]?.content).toContain("heart emoji");
  });

  it("normalizes legacy done status to completed", async () => {
    const addResult = await toolExecute(todoWriteTool, {
      operation: "add",
      content: "Verify completed status mapping",
    });

    const todoId = addResult.todo?.id as number | undefined;
    expect(typeof todoId).toBe("number");

    const updateResult = await toolExecute(todoWriteTool, {
      operation: "update",
      id: todoId,
      status: "done",
    });

    expect(updateResult.success).toBe(true);

    const completedResult = await toolExecute(todoReadTool, {
      statusFilter: "completed",
    });

    expect(completedResult.filtered).toBe(1);
    expect(completedResult.completed).toBe(1);
    expect(completedResult.todos[0]?.status).toBe("completed");
  });

  it("supports clear_done alias while clearing completed todos", async () => {
    const addResult = await toolExecute(todoWriteTool, {
      operation: "add",
      content: "Temporary task",
    });

    const todoId = addResult.todo?.id as number | undefined;

    await toolExecute(todoWriteTool, {
      operation: "update",
      id: todoId,
      status: "completed",
    });

    const clearResult = await toolExecute(todoWriteTool, {
      operation: "clear_done",
    });

    expect(clearResult.success).toBe(true);
    expect(clearResult.cleared_count).toBe(1);

    const remaining = await toolExecute(todoReadTool, {
      statusFilter: "all",
    });
    expect(remaining.total).toBe(0);
  });
});
