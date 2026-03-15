import { describe, expect, it, vi, beforeEach } from "vitest";

import { runProxyToolLoop } from "../proxy-tool-runner.js";
import { generateCompletion } from "../openrouter.js";

vi.mock("@/ai/openrouter.js", () => ({
  generateCompletion: vi.fn(),
}));

type MockedGenerateCompletion = {
  mockResolvedValueOnce: (value: unknown) => MockedGenerateCompletion;
  mockResolvedValue: (value: unknown) => MockedGenerateCompletion;
  mock: { calls: Array<Array<any>> };
};

const mockedGenerateCompletion = generateCompletion as unknown as MockedGenerateCompletion;

describe("runProxyToolLoop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("executes tool actions parsed from noisy fenced JSON", async () => {
    const readFileExecute = vi.fn().mockResolvedValue({ content: "hello" });

    mockedGenerateCompletion
      .mockResolvedValueOnce({
        text: [
          "I'll inspect the file first.",
          "```json",
          '{"tool_call":{"name":"readFile","arguments":{"filePath":"./README.md"}}}',
          "```",
        ].join("\n"),
        promptTokens: 10,
        completionTokens: 6,
      })
      .mockResolvedValueOnce({
        text: '{"type":"final","message":"Read complete."}',
        promptTokens: 8,
        completionTokens: 4,
      });

    const result = await runProxyToolLoop({
      model: "test-model",
      system: "test-system",
      messages: [{ role: "user", content: "Read README and summarize" } as any],
      tools: {
        readFile: {
          description: "read a file",
          execute: readFileExecute,
        },
      } as any,
      useProxy: true,
    });

    expect(readFileExecute).toHaveBeenCalledTimes(1);
    expect(readFileExecute).toHaveBeenCalledWith({ filePath: "./README.md" });
    expect(result.finalText).toContain("Read complete");
    expect(result.iterations).toBe(2);
  });

  it("accepts alias formats like action + args for tool calls", async () => {
    const listDirExecute = vi.fn().mockResolvedValue({ entries: ["src/"] });

    mockedGenerateCompletion
      .mockResolvedValueOnce({
        text: '{"action":"listDir","args":{"dirPath":"."}}',
        promptTokens: 9,
        completionTokens: 5,
      })
      .mockResolvedValueOnce({
        text: '{"type":"final","message":"Directory listed."}',
        promptTokens: 6,
        completionTokens: 3,
      });

    const result = await runProxyToolLoop({
      model: "test-model",
      system: "test-system",
      messages: [{ role: "user", content: "List files in project" } as any],
      tools: {
        listDir: {
          description: "list directories",
          execute: listDirExecute,
        },
      } as any,
      useProxy: true,
    });

    expect(listDirExecute).toHaveBeenCalledWith({ dirPath: "." });
    expect(result.finalText).toContain("Directory listed");
  });

  it("does not trap completed final responses in reject loops", async () => {
    mockedGenerateCompletion.mockResolvedValueOnce({
      text: '{"type":"final","message":"I fixed the auth guard and completed the update. You can run npm test to verify."}',
      promptTokens: 7,
      completionTokens: 5,
    });

    const result = await runProxyToolLoop({
      model: "test-model",
      system: "test-system",
      messages: [{ role: "user", content: "Fix auth.ts token validation bug" } as any],
      tools: {} as any,
      useProxy: true,
      maxIterations: 4,
    });

    expect(result.finalText).toContain("completed the update");
    expect(result.iterations).toBe(1);
  });

  it("retries when tool-actionable requests return final text before any tool execution", async () => {
    const listDirExecute = vi.fn().mockResolvedValue({ entries: ["src/"] });

    mockedGenerateCompletion
      .mockResolvedValueOnce({
        text: '{"type":"final","message":"First, let\'s run mkdir -p demo and then continue."}',
        promptTokens: 7,
        completionTokens: 4,
      })
      .mockResolvedValueOnce({
        text: '{"type":"tool","tool":"listDir","input":{"dirPath":"."}}',
        promptTokens: 8,
        completionTokens: 5,
      })
      .mockResolvedValueOnce({
        text: '{"type":"final","message":"Done. Directory listed."}',
        promptTokens: 6,
        completionTokens: 3,
      });

    const result = await runProxyToolLoop({
      model: "test-model",
      system: "test-system",
      messages: [{ role: "user", content: "List project files" } as any],
      tools: {
        listDir: {
          description: "list directory",
          execute: listDirExecute,
        },
      } as any,
      useProxy: true,
      maxIterations: 5,
    });

    expect(listDirExecute).toHaveBeenCalledTimes(1);
    expect(result.finalText).toContain("Directory listed");
    expect(result.iterations).toBe(3);
  });

  it("requires a successful verification step after mutation before finalizing", async () => {
    const writeFileExecute = vi.fn().mockResolvedValue({ success: true });
    const readFileExecute = vi.fn().mockResolvedValue({ content: "ok" });

    mockedGenerateCompletion
      .mockResolvedValueOnce({
        text: '{"type":"tool","tool":"writeFile","input":{"filePath":"./demo.txt","content":"ok"}}',
        promptTokens: 9,
        completionTokens: 5,
      })
      .mockResolvedValueOnce({
        text: '{"type":"final","message":"Done."}',
        promptTokens: 6,
        completionTokens: 3,
      })
      .mockResolvedValueOnce({
        text: '{"type":"tool","tool":"readFile","input":{"filePath":"./demo.txt"}}',
        promptTokens: 7,
        completionTokens: 4,
      })
      .mockResolvedValueOnce({
        text: '{"type":"final","message":"Done. Verified file contents."}',
        promptTokens: 6,
        completionTokens: 3,
      });

    const result = await runProxyToolLoop({
      model: "test-model",
      system: "test-system",
      messages: [{ role: "user", content: "Create demo.txt with ok" } as any],
      tools: {
        writeFile: {
          description: "write file",
          execute: writeFileExecute,
        },
        readFile: {
          description: "read file",
          execute: readFileExecute,
        },
      } as any,
      useProxy: true,
      maxIterations: 6,
    });

    expect(writeFileExecute).toHaveBeenCalledTimes(1);
    expect(readFileExecute).toHaveBeenCalledTimes(1);
    expect(result.finalText).toContain("Verified file contents");
    expect(result.iterations).toBe(4);
  });

  it("allows concise final responses even when they include command-like phrasing", async () => {
    mockedGenerateCompletion.mockResolvedValueOnce({
      text: '{"type":"final","message":"Done. Run npm test to verify."}',
      promptTokens: 5,
      completionTokens: 3,
    });

    const result = await runProxyToolLoop({
      model: "test-model",
      system: "test-system",
      messages: [{ role: "user", content: "Fix README typo in project" } as any],
      tools: {} as any,
      useProxy: true,
      maxIterations: 4,
    });

    expect(result.finalText).toContain("Run npm test");
    expect(result.iterations).toBe(1);
  });

  it("includes tool parameter hints in planner system prompt", async () => {
    const listDirExecute = vi.fn().mockResolvedValue({ entries: ["src/"] });

    mockedGenerateCompletion
      .mockResolvedValueOnce({
        text: '{"type":"tool","tool":"listDir","input":{"dirPath":"."}}',
        promptTokens: 7,
        completionTokens: 4,
      })
      .mockResolvedValueOnce({
        text: '{"type":"final","message":"done"}',
        promptTokens: 6,
        completionTokens: 2,
      });

    await runProxyToolLoop({
      model: "test-model",
      system: "test-system",
      messages: [{ role: "user", content: "List files" } as any],
      tools: {
        listDir: {
          description: "List files and directories",
          inputSchema: {
            _def: {
              shape: {
                dirPath: {
                  _def: { typeName: "ZodString", description: "Directory path to list" },
                  description: "Directory path to list",
                },
              },
            },
          },
          execute: listDirExecute,
        },
      } as any,
      useProxy: true,
    });

    const firstCall = mockedGenerateCompletion.mock.calls[0]?.[0];
    expect(firstCall?.system).toContain("Parameters:");
    expect(firstCall?.system).toContain("dirPath (string)");
  });

  it("stops repeated identical mutating tool loops after a successful run", async () => {
    const writeFileExecute = vi.fn().mockResolvedValue({ success: true, path: "./notes.txt" });

    mockedGenerateCompletion
      .mockResolvedValueOnce({
        text: '{"type":"tool","tool":"writeFile","input":{"filePath":"./notes.txt","content":"hello"}}',
        promptTokens: 11,
        completionTokens: 7,
      })
      .mockResolvedValueOnce({
        text: '{"type":"tool","tool":"writeFile","input":{"filePath":"./notes.txt","content":"hello"}}',
        promptTokens: 9,
        completionTokens: 6,
      })
      .mockResolvedValue({
        text: '{"type":"final","message":"done"}',
        promptTokens: 5,
        completionTokens: 3,
      });

    const result = await runProxyToolLoop({
      model: "test-model",
      system: "test-system",
      messages: [{ role: "user", content: "Create notes.txt with hello" } as any],
      tools: {
        writeFile: {
          description: "write a file",
          execute: writeFileExecute,
        },
      } as any,
      useProxy: true,
      maxIterations: 6,
    });

    expect(writeFileExecute).toHaveBeenCalledTimes(2);
    expect(result.finalText).toContain("Completed the requested file changes successfully.");
    expect(result.iterations).toBe(2);
  });

  it("does not trigger duplicate mutation guard when the first mutation fails", async () => {
    const writeFileExecute = vi
      .fn()
      .mockResolvedValueOnce({ error: "permission denied" })
      .mockResolvedValueOnce({ success: true, path: "./notes.txt" });
    const readFileExecute = vi.fn().mockResolvedValue({ content: "hello" });

    mockedGenerateCompletion
      .mockResolvedValueOnce({
        text: '{"type":"tool","tool":"writeFile","input":{"filePath":"./notes.txt","content":"hello"}}',
        promptTokens: 11,
        completionTokens: 7,
      })
      .mockResolvedValueOnce({
        text: '{"type":"tool","tool":"writeFile","input":{"filePath":"./notes.txt","content":"hello"}}',
        promptTokens: 9,
        completionTokens: 6,
      })
      .mockResolvedValueOnce({
        text: '{"type":"tool","tool":"readFile","input":{"filePath":"./notes.txt"}}',
        promptTokens: 8,
        completionTokens: 4,
      })
      .mockResolvedValueOnce({
        text: '{"type":"final","message":"write completed on retry"}',
        promptTokens: 5,
        completionTokens: 3,
      });

    const result = await runProxyToolLoop({
      model: "test-model",
      system: "test-system",
      messages: [{ role: "user", content: "Create notes.txt with hello" } as any],
      tools: {
        writeFile: {
          description: "write a file",
          execute: writeFileExecute,
        },
        readFile: {
          description: "read file",
          execute: readFileExecute,
        },
      } as any,
      useProxy: true,
      maxIterations: 6,
    });

    expect(writeFileExecute).toHaveBeenCalledTimes(2);
    expect(readFileExecute).toHaveBeenCalledTimes(1);
    expect(result.finalText).toContain("write completed on retry");
    expect(result.iterations).toBe(4);
  });
});
