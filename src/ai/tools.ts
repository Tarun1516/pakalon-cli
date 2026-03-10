/**
 * Tool definitions for the Pakalon agent.
 * Compatible with Vercel AI SDK tool() format.
 */
import { tool } from "ai";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import logger from "@/utils/logger.js";
import { useStore } from "@/store/index.js";
import { withExitCode, BlockedByExit2Error } from "@/ai/exit-code.js";
import { permissionGate } from "@/ai/permission-gate.js";
import { undoManager } from "@/ai/undo-manager.js";
import { getFileDiagnostics } from "@/lsp/index.js";
import {
  runPreWriteHooks,
  runPostWriteHooks,
  runPreEditHooks,
  runPostEditHooks,
  runPreBashHooks,
  runPostBashHooks,
} from "@/ai/hooks.js";

function isInteractivePermissionMode(permissionMode: string): boolean {
  return permissionMode === "normal";
}

function isToolingDisabled(permissionMode: string): boolean {
  return permissionMode === "orchestration";
}

export const readFileTool = tool({
  description: "Read the content of a file from the filesystem",
  inputSchema: z.object({
    filePath: z.string().describe("Absolute or relative path to the file"),
    maxBytes: z.number().optional().describe("Max bytes to read (default 32768)"),
  }),
  execute: async ({ filePath, maxBytes = 32768 }) => {
    try {
      const { permissionMode } = useStore.getState();
      if (isToolingDisabled(permissionMode)) {
        return { error: "Read blocked: orchestration mode is Q&A only.", blocked: true, permissionMode };
      }
      if (isInteractivePermissionMode(permissionMode)) {
        const absPath = path.resolve(filePath);
        const allowed = await permissionGate.requestPermission(
          "readFile",
          `Read file: ${absPath}`,
          { filePath: absPath, maxBytes },
        );
        if (!allowed) {
          return { error: "Read declined by user.", blocked: true, permissionMode };
        }
      }
      const abs = path.resolve(filePath);
      const stat = fs.statSync(abs);
      if (stat.size > 1_000_000) {
        return { error: "File too large (>1MB). Use maxBytes to read a portion." };
      }
      const content = fs.readFileSync(abs, "utf-8").slice(0, maxBytes);
      return { content, truncated: stat.size > maxBytes };
    } catch (err) {
      logger.error("readFile tool error", { filePath, err: String(err) });
      return { error: String(err) };
    }
  },
});

export const writeFileTool = tool({
  description: "Write content to a file on the filesystem",
  inputSchema: z.object({
    filePath: z.string().describe("Path to write to"),
    content: z.string().describe("The content to write"),
    append: z.boolean().optional().describe("Append instead of overwrite"),
  }),
  execute: async ({ filePath, content, append = false }) => {
    // Block all writes in Plan mode — only read-only actions allowed
    const { permissionMode } = useStore.getState();
    if (permissionMode === "plan" || isToolingDisabled(permissionMode)) {
      return {
        error: "Write blocked in the current mode. Switch to normal or auto-accept to allow file writes.",
        blocked: true,
        permissionMode,
      };
    }

    // Edit mode: ask human for permission before writing
    // Skip if user chose "accept all" this session
    const autoAccept = (globalThis as Record<string, unknown>).PAKALON_PERMISSION_AUTO_ACCEPT === true;
    if (isInteractivePermissionMode(permissionMode) && !autoAccept) {
      const abs = path.resolve(filePath);
      const allowed = await permissionGate.requestPermission(
        "writeFile",
        `${append ? "Append to" : "Write"} file: ${abs}`,
        { filePath: abs, byteCount: content.length, append },
      );
      if (!allowed) {
        return { error: "Write declined by user.", blocked: true, permissionMode };
      }
    }

    try {
      const abs = path.resolve(filePath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });

      // Snapshot for undo (before writing)
      const previousContent = fs.existsSync(abs)
        ? fs.readFileSync(abs, "utf-8")
        : null;

      await runPreWriteHooks(abs);
      if (append) {
        fs.appendFileSync(abs, content, "utf-8");
        undoManager.record(abs, content, previousContent);
      } else {
        fs.writeFileSync(abs, content, "utf-8");
        undoManager.record(abs, content, previousContent);
      }
      await runPostWriteHooks(abs);

      // Record session file-change stats for the FileChangeSummary panel
      try {
        const prevLines = previousContent ? previousContent.split("\n").length : 0;
        const newLines = content.split("\n").length;
        const added = Math.max(0, newLines - prevLines);
        const deleted = Math.max(0, prevLines - newLines);
        useStore.getState().recordFileChange(abs, added, deleted);
      } catch {
        // Non-critical — ignore errors from stats tracking
      }

      // T-LSP-04: fetch diagnostics after write so the AI sees errors immediately
      let lspDiagnostics: unknown[] = [];
      try {
        const diags = await getFileDiagnostics(abs);
        if (diags.length > 0) {
          lspDiagnostics = diags.map((d) => ({
            severity: d.severity,
            message: d.message,
            line: d.line != null ? d.line + 1 : undefined,
            source: d.source ?? undefined,
          }));
        }
      } catch {
        // LSP may not be running — non-fatal
      }

      return {
        success: true,
        path: abs,
        ...(lspDiagnostics.length > 0 ? { lspDiagnostics, diagnosticCount: lspDiagnostics.length } : {}),
      };
    } catch (err) {
      logger.error("writeFile tool error", { filePath, err: String(err) });
      return { error: String(err) };
    }
  },
});

export const listDirTool = tool({
  description: "List files and directories at a given path",
  inputSchema: z.object({
    dirPath: z.string().describe("Directory to list"),
    recursive: z.boolean().optional().describe("Recursively list (default false)"),
  }),
  execute: async ({ dirPath, recursive = false }) => {
    try {
      const { permissionMode } = useStore.getState();
      if (isToolingDisabled(permissionMode)) {
        return { error: "List blocked: orchestration mode is Q&A only.", blocked: true, permissionMode };
      }
      if (isInteractivePermissionMode(permissionMode)) {
        const absPath = path.resolve(dirPath);
        const allowed = await permissionGate.requestPermission(
          "listDir",
          `List directory: ${absPath}`,
          { dirPath: absPath, recursive },
        );
        if (!allowed) {
          return { error: "Directory listing declined by user.", blocked: true, permissionMode };
        }
      }
      const abs = path.resolve(dirPath);
      if (recursive) {
        const results: string[] = [];
        const walk = (dir: string) => {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const e of entries) {
            const full = path.join(dir, e.name);
            results.push(path.relative(abs, full) + (e.isDirectory() ? "/" : ""));
            if (e.isDirectory() && results.length < 500) walk(full);
          }
        };
        walk(abs);
        return { entries: results.slice(0, 500), truncated: results.length >= 500 };
      }
      const entries = fs.readdirSync(abs, { withFileTypes: true }).map((e) =>
        e.name + (e.isDirectory() ? "/" : "")
      );
      return { entries };
    } catch (err) {
      return { error: String(err) };
    }
  },
});

export const bashTool = tool({
  description: "Execute a shell command and return stdout/stderr",
  inputSchema: z.object({
    command: z.string().describe("Shell command to execute"),
    cwd: z.string().optional().describe("Working directory"),
    timeout: z.number().optional().describe("Timeout in milliseconds (default 15000)"),
  }),
  execute: async ({ command, cwd, timeout = 15000 }) => {
    // Block commands that modify the filesystem in Plan mode
    const { permissionMode } = useStore.getState();
    const writePatterns = /\b(rm|rmdir|mv|cp|mkdir|touch|chmod|chown|install|npm|yarn|pnpm|pip|apt|brew)\b|>>?|tee\b|curl\s.*-o\b|wget\b/;
    if (permissionMode === "plan" || isToolingDisabled(permissionMode)) {
      if (writePatterns.test(command)) {
        return {
          error: "Command blocked in the current mode. This command appears to modify files or install packages.",
          blocked: true,
          permissionMode,
        };
      }
      if (isToolingDisabled(permissionMode)) {
        return {
          error: "Command blocked: orchestration mode is Q&A only.",
          blocked: true,
          permissionMode,
        };
      }
    }

    // Edit mode: ask human for permission if command looks destructive
    const autoAccept = (globalThis as Record<string, unknown>).PAKALON_PERMISSION_AUTO_ACCEPT === true;
    if (isInteractivePermissionMode(permissionMode) && !autoAccept) {
      const allowed = await permissionGate.requestPermission(
        "bash",
        `Execute command: ${command}`,
        { command, cwd: cwd ?? process.cwd() },
      );
      if (!allowed) {
        return { error: "Command declined by user.", blocked: true, permissionMode };
      }
    }

    try {
      await runPreBashHooks(command);
      // T-HK-14: Source PAKALON_ENV_FILE before command if present
      const envFilePath = process.env["PAKALON_ENV_FILE"];
      const envFilePrefix = envFilePath && require("fs").existsSync(envFilePath)
        ? `. "${envFilePath}" 2>/dev/null; `
        : "";
      const bashResult = withExitCode(() => {
        const rawStdout = execSync(envFilePrefix + command, {
          cwd: cwd ? path.resolve(cwd) : process.cwd(),
          timeout,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        return { stdout: String(rawStdout).slice(0, 16384), stderr: "", exitCode: 0 };
      }, false, /* throwOnExit2= */ true);      await runPostBashHooks(command);
      return bashResult;    } catch (exit2Err) {
      if (exit2Err instanceof BlockedByExit2Error) {
        // Surface exit 2 as a permission-request to the TUI
        const message = exit2Err.message || "Command exited with code 2 — user action required";
        const allowed = await permissionGate.requestPermission(
          "exit2_override",
          `Command hit an access wall (exit 2):\n  ${command}\n\nReason: ${message}\n\nAllow override and continue?`,
          { command, cwd: cwd ?? process.cwd(), exitCode: 2, stderr: exit2Err.stderr }
        );
        if (!allowed) {
          return {
            success: false,
            exitCode: 2,
            error: `Blocked by exit code 2: ${message}`,
            blocked: true,
            requiresPermission: true,
          };
        }
        // User approved — re-run without exit-2 blocking
        return withExitCode(() => {
          const rawStdout = execSync(envFilePrefix + command, {
            cwd: cwd ? path.resolve(cwd) : process.cwd(),
            timeout,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
          });
          return { stdout: String(rawStdout).slice(0, 16384), stderr: "", exitCode: 0 };
        }, false, false);
      }
      throw exit2Err;
    }
  },
});

export const imageAnalysisTool = tool({
  description: "Analyze an image using the local Python bridge server",
  inputSchema: z.object({
    path: z.string().describe("Absolute path to the image file"),
  }),
  execute: async ({ path }) => {
    try {
      const res = await fetch("http://127.0.0.1:7432/tools/analyze_image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      if (!res.ok) {
        return { error: `Bridge server returned ${res.status}` };
      }
      const data = await res.json();
      return data;
    } catch (err) {
      logger.error("imageAnalysis tool error", { path, err: String(err) });
      return { error: String(err) };
    }
  },
});

export const videoAnalysisTool = tool({
  description: "Analyze a video using the local Python bridge server",
  inputSchema: z.object({
    path: z.string().describe("Absolute path to the video file"),
    fps: z.number().optional().describe("Frames per second to extract (default 1)"),
  }),
  execute: async ({ path, fps = 1 }) => {
    try {
      const res = await fetch("http://127.0.0.1:7432/tools/analyze_video", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, fps }),
      });
      if (!res.ok) {
        return { error: `Bridge server returned ${res.status}` };
      }
      const data = await res.json();
      return data;
    } catch (err) {
      logger.error("videoAnalysis tool error", { path, err: String(err) });
      return { error: String(err) };
    }
  },
});

/**
 * T-CLI-P8: Pro-only image generation via Flux/DALL-E/StabilityAI/Replicate.
 * Requires user_plan="pro" — blocked for free users.
 */
export const generateImageTool = tool({
  description:
    "Generate an AI image from a text prompt (Pro-only). " +
    "Supports Flux.1, DALL-E 3, Stability AI SD3, and Replicate. " +
    "Returns the saved image path and base64 data.",
  inputSchema: z.object({
    prompt: z.string().describe("Detailed text description of the image to generate"),
    outputPath: z
      .string()
      .optional()
      .describe("Absolute path to save the generated image (optional — temp file if omitted)"),
    model: z
      .enum(["flux", "flux-schnell", "flux-pro", "dall-e-3", "sdxl", "sd3"])
      .optional()
      .default("flux")
      .describe("Generation model to use"),
    width: z.number().optional().default(1024).describe("Image width in pixels"),
    height: z.number().optional().default(1024).describe("Image height in pixels"),
    steps: z.number().optional().default(28).describe("Inference steps (higher = quality, slower)"),
    guidance: z.number().optional().default(3.5).describe("Guidance scale"),
    userPlan: z.string().optional().default("free").describe("User subscription plan"),
  }),
  execute: async ({ prompt, outputPath, model = "flux", width = 1024, height = 1024, steps = 28, guidance = 3.5, userPlan = "free" }) => {
    // Block all generative/write tools in Plan mode
    const { permissionMode } = useStore.getState();
    if (permissionMode === "plan") {
      return {
        error: "generateImage blocked: permission mode is 'plan'. Switch to 'edit' or 'auto-accept' to allow image generation.",
        blocked: true,
        permissionMode,
      };
    }
    try {
      const res = await fetch("http://127.0.0.1:7432/tools/generate_image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          output_path: outputPath ?? null,
          model,
          width,
          height,
          steps,
          guidance,
          user_plan: userPlan,
        }),
      });
      if (!res.ok) {
        return { error: `Bridge server returned ${res.status}` };
      }
      const data = await res.json();
      return data;
    } catch (err) {
      logger.error("generateImage tool error", { prompt, err: String(err) });
      return { error: String(err) };
    }
  },
});

/**
 * T-CLI-P8: Pro-only video generation via Runway Gen-3, Replicate, or fal.ai.
 * Requires user_plan="pro" — blocked for free users.
 */
export const generateVideoTool = tool({
  description:
    "Generate an AI video from a text prompt (Pro-only). " +
    "Supports fal.ai MiniMax, Runway Gen-3 Alpha, and Replicate. " +
    "Optionally accepts an initial image for image-to-video generation.",
  inputSchema: z.object({
    prompt: z.string().describe("Text description of the video to generate"),
    imagePath: z
      .string()
      .optional()
      .describe("Optional starting image path for image-to-video"),
    outputPath: z
      .string()
      .optional()
      .describe("Absolute path to save the generated MP4 (optional)"),
    model: z
      .enum(["minimax", "wan", "runway", "svd"])
      .optional()
      .default("minimax")
      .describe("Video generation model"),
    duration: z.number().optional().default(5).describe("Video duration in seconds (1–10)"),
    userPlan: z.string().optional().default("free").describe("User subscription plan"),
  }),
  execute: async ({ prompt, imagePath, outputPath, model = "minimax", duration = 5, userPlan = "free" }) => {
    // Block all generative/write tools in Plan mode
    const { permissionMode } = useStore.getState();
    if (permissionMode === "plan") {
      return {
        error: "generateVideo blocked: permission mode is 'plan'. Switch to 'edit' or 'auto-accept' to allow video generation.",
        blocked: true,
        permissionMode,
      };
    }
    try {
      const res = await fetch("http://127.0.0.1:7432/tools/generate_video", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          image_path: imagePath ?? null,
          output_path: outputPath ?? null,
          model,
          duration,
          user_plan: userPlan,
        }),
      });
      if (!res.ok) {
        return { error: `Bridge server returned ${res.status}` };
      }
      const data = await res.json();
      return data;
    } catch (err) {
      logger.error("generateVideo tool error", { prompt, err: String(err) });
      return { error: String(err) };
    }
  },
});

// ---------------------------------------------------------------------------
// T-CLI-P14: Cloud storage tools (MinIO/S3 + Cloudinary)
// ---------------------------------------------------------------------------

const BRIDGE_BASE = process.env["PAKALON_BRIDGE_URL"] ?? "http://localhost:7432";

async function bridgePost(endpoint: string, body: object): Promise<any> {
  const resp = await fetch(`${BRIDGE_BASE}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`Bridge ${endpoint} → HTTP ${resp.status}`);
  return resp.json();
}

export const uploadFileTool = tool({
  description: "Upload a local file to cloud storage (MinIO/S3 or Cloudinary). Pro-only.",
  inputSchema: z.object({
    localPath: z.string().describe("Absolute path to the local file to upload"),
    remoteKey: z.string().optional().describe("Remote storage key/path (auto-generated if omitted)"),
    provider: z.enum(["minio", "cloudinary"]).optional().describe("Force a specific provider"),
    public: z.boolean().optional().default(true).describe("Whether the uploaded file should be publicly accessible"),
    userPlan: z.string().optional().default("free").describe("User subscription plan"),
  }),
  execute: async ({ localPath, remoteKey, provider, public: pub, userPlan }) => {
    // Block cloud storage mutations in Plan mode
    const { permissionMode } = useStore.getState();
    if (permissionMode === "plan") {
      return {
        error: "uploadFile blocked: permission mode is 'plan'. Switch to 'edit' or 'auto-accept' to allow file uploads.",
        blocked: true,
        permissionMode,
      };
    }
    try {
      const result = await bridgePost("/tools/storage/upload", {
        local_path: localPath,
        remote_key: remoteKey,
        provider,
        public: pub,
        user_plan: userPlan ?? "free",
      });
      return result;
    } catch (err) {
      logger.error("uploadFile tool error", { localPath, err: String(err) });
      return { success: false, error: String(err) };
    }
  },
});

export const downloadFileTool = tool({
  description: "Download a file from cloud storage (MinIO/S3 or Cloudinary) to disk. Pro-only.",
  inputSchema: z.object({
    remoteKey: z.string().describe("Remote storage key/path"),
    localPath: z.string().optional().describe("Where to save the file locally (auto-generated if omitted)"),
    provider: z.enum(["minio", "cloudinary"]).optional(),
    userPlan: z.string().optional().default("free"),
  }),
  execute: async ({ remoteKey, localPath, provider, userPlan }) => {
    // Block cloud storage mutations in Plan mode
    const { permissionMode } = useStore.getState();
    if (permissionMode === "plan") {
      return {
        error: "downloadFile blocked: permission mode is 'plan'. Switch to 'edit' or 'auto-accept' to allow file downloads.",
        blocked: true,
        permissionMode,
      };
    }
    try {
      return await bridgePost("/tools/storage/download", {
        remote_key: remoteKey,
        local_path: localPath,
        provider,
        user_plan: userPlan ?? "free",
      });
    } catch (err) {
      logger.error("downloadFile tool error", { remoteKey, err: String(err) });
      return { success: false, error: String(err) };
    }
  },
});

export const deleteFileTool = tool({
  description: "Delete a file from cloud storage. Pro-only.",
  inputSchema: z.object({
    remoteKey: z.string().describe("Remote storage key to delete"),
    provider: z.enum(["minio", "cloudinary"]).optional(),
    userPlan: z.string().optional().default("free"),
  }),
  execute: async ({ remoteKey, provider, userPlan }) => {
    // Block cloud storage mutations in Plan mode
    const { permissionMode } = useStore.getState();
    if (permissionMode === "plan") {
      return {
        error: "deleteFile blocked: permission mode is 'plan'. Switch to 'edit' or 'auto-accept' to allow file deletion.",
        blocked: true,
        permissionMode,
      };
    }
    try {
      return await bridgePost("/tools/storage/delete", {
        remote_key: remoteKey,
        provider,
        user_plan: userPlan ?? "free",
      });
    } catch (err) {
      logger.error("deleteFile tool error", { remoteKey, err: String(err) });
      return { success: false, error: String(err) };
    }
  },
});

export const listFilesTool = tool({
  description: "List files in cloud storage under a given prefix/folder. Pro-only.",
  inputSchema: z.object({
    prefix: z.string().optional().default("").describe("Prefix/folder to list (default: top-level)"),
    provider: z.enum(["minio", "cloudinary"]).optional(),
    userPlan: z.string().optional().default("free"),
  }),
  execute: async ({ prefix, provider, userPlan }) => {
    // listFiles is read-only but plan mode still allows it — no block needed.
    // However, if a plan-mode user somehow calls it with write-ish intent, we still allow listing.
    try {
      return await bridgePost("/tools/storage/list", {
        prefix: prefix ?? "",
        provider,
        user_plan: userPlan ?? "free",
      });
    } catch (err) {
      logger.error("listFiles tool error", { prefix, err: String(err) });
      return { success: false, files: [], error: String(err) };
    }
  },
});

// ---------------------------------------------------------------------------
// Edit file (diff/patch) — T-CLI-EDIT
// ---------------------------------------------------------------------------

/**
 * Edit a specific section of a file by replacing oldString with newString.
 * More precise than writeFile — preserves surrounding content.
 */
export const editFileTool = tool({
  description:
    "Edit a file by replacing a specific string or section with new content. " +
    "Safer than writeFile — only changes the specified region. " +
    "Use oldString to uniquely identify the text to replace and newString for the replacement.",
  inputSchema: z.object({
    filePath: z.string().describe("Path to the file to edit"),
    oldString: z.string().describe("The exact text to find and replace (must be unique in the file)"),
    newString: z.string().describe("The replacement text"),
    allowMultiple: z.boolean().optional().default(false).describe("Replace all occurrences (default: false, fail if >1 match)"),
  }),
  execute: async ({ filePath, oldString, newString, allowMultiple = false }) => {
    const { permissionMode } = useStore.getState();
    if (permissionMode === "plan" || isToolingDisabled(permissionMode)) {
      return { error: "Edit blocked: permission mode is 'plan'.", blocked: true };
    }

    const autoAccept = (globalThis as Record<string, unknown>).PAKALON_PERMISSION_AUTO_ACCEPT === true;
    if (isInteractivePermissionMode(permissionMode) && !autoAccept) {
      const abs = path.resolve(filePath);
      const allowed = await permissionGate.requestPermission(
        "editFile",
        `Edit file: ${abs}`,
        { filePath: abs, oldString: oldString.slice(0, 80), newString: newString.slice(0, 80) },
      );
      if (!allowed) return { error: "Edit declined by user.", blocked: true };
    }

    try {
      const abs = path.resolve(filePath);
      const content = fs.readFileSync(abs, "utf-8");
      const occurrences = content.split(oldString).length - 1;

      if (occurrences === 0) {
        return { error: `oldString not found in ${abs}`, found: 0 };
      }
      if (occurrences > 1 && !allowMultiple) {
        return {
          error: `oldString matches ${occurrences} locations in ${abs}. Make it more specific or set allowMultiple=true.`,
          found: occurrences,
        };
      }

      const previousContent = content;
      const updated = allowMultiple
        ? content.split(oldString).join(newString)
        : content.replace(oldString, newString);

      await runPreEditHooks(abs);
      undoManager.record(abs, updated, previousContent);
      fs.writeFileSync(abs, updated, "utf-8");
      await runPostEditHooks(abs);

      // T-LSP-04: fetch diagnostics after edit so the AI sees errors immediately
      let editDiagnostics: unknown[] = [];
      try {
        const diags = await getFileDiagnostics(abs);
        if (diags.length > 0) {
          editDiagnostics = diags.map((d) => ({
            severity: d.severity,
            message: d.message,
            line: d.line != null ? d.line + 1 : undefined,
            source: d.source ?? undefined,
          }));
        }
      } catch {
        // LSP may not be running — non-fatal
      }

      return {
        success: true,
        path: abs,
        replacements: occurrences,
        ...(editDiagnostics.length > 0 ? { lspDiagnostics: editDiagnostics, diagnosticCount: editDiagnostics.length } : {}),
      };
    } catch (err) {
      return { error: String(err) };
    }
  },
});

// ---------------------------------------------------------------------------
// Multi-file edit — T-CLI-MULTIEDIT
// ---------------------------------------------------------------------------

/**
 * Apply multiple edits across one or more files in a single operation.
 * Each edit specifies filePath + oldString + newString.
 */
export const multiEditFilesTool = tool({
  description:
    "Apply multiple string replacements across multiple files in one operation. " +
    "Each edit specifies the file, the exact text to find, and the replacement. " +
    "All edits are applied atomically — if any fails, the rest still proceed and errors are reported.",
  inputSchema: z.object({
    edits: z.array(
      z.object({
        filePath: z.string(),
        oldString: z.string(),
        newString: z.string(),
      })
    ).describe("Array of {filePath, oldString, newString} edit operations"),
  }),
  execute: async ({ edits }) => {
    const { permissionMode } = useStore.getState();
    if (permissionMode === "plan" || isToolingDisabled(permissionMode)) {
      return { error: "Multi-edit blocked: permission mode is 'plan'.", blocked: true };
    }

    const autoAccept = (globalThis as Record<string, unknown>).PAKALON_PERMISSION_AUTO_ACCEPT === true;
    if (isInteractivePermissionMode(permissionMode) && !autoAccept) {
      const summary = edits.map((e) => path.basename(e.filePath)).join(", ");
      const allowed = await permissionGate.requestPermission(
        "multiEditFiles",
        `Edit ${edits.length} file(s): ${summary}`,
        { fileCount: edits.length },
      );
      if (!allowed) return { error: "Multi-edit declined by user.", blocked: true };
    }

    const results: Array<{ filePath: string; success: boolean; error?: string; replacements?: number }> = [];

    for (const edit of edits) {
      try {
        const abs = path.resolve(edit.filePath);
        const content = fs.readFileSync(abs, "utf-8");
        const occurrences = content.split(edit.oldString).length - 1;
        if (occurrences === 0) {
          results.push({ filePath: abs, success: false, error: "oldString not found" });
          continue;
        }
        const previousContent = content;
        const updated = content.replace(edit.oldString, edit.newString);
        await runPreEditHooks(abs);
        undoManager.record(abs, updated, previousContent);
        fs.writeFileSync(abs, updated, "utf-8");
        await runPostEditHooks(abs);
        results.push({ filePath: abs, success: true, replacements: occurrences });
      } catch (err) {
        results.push({ filePath: edit.filePath, success: false, error: String(err) });
      }
    }

    const successCount = results.filter((r) => r.success).length;
    return { results, succeeded: successCount, failed: results.length - successCount };
  },
});

// ---------------------------------------------------------------------------
// Glob/Find tool — T-CLI-GLOB
// ---------------------------------------------------------------------------

export const globFindTool = tool({
  description:
    "Find files matching a glob pattern. " +
    "Examples: '**/*.ts', 'src/**/*.test.ts', 'components/*.tsx'. " +
    "Returns matching file paths relative to the search directory.",
  inputSchema: z.object({
    pattern: z.string().describe("Glob pattern to match (e.g. '**/*.ts')"),
    cwd: z.string().optional().describe("Directory to search from (default: current working directory)"),
    maxResults: z.number().optional().default(200).describe("Maximum number of results (default 200)"),
    excludePatterns: z.array(z.string()).optional().describe("Patterns to exclude (e.g. ['node_modules/**', '.git/**'])"),
  }),
  execute: async ({ pattern, cwd, maxResults = 200, excludePatterns = ["node_modules/**", ".git/**", "dist/**", ".next/**"] }) => {
    try {
      const searchDir = path.resolve(cwd ?? process.cwd());

      // Use a simple recursive walk with pattern matching
      const results: string[] = [];
      const { minimatch } = await import("minimatch").catch(() => ({ minimatch: null }));

      const walk = (dir: string, base: string) => {
        if (results.length >= maxResults) return;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
          if (results.length >= maxResults) break;
          const rel = base ? `${base}/${e.name}` : e.name;
          // Check exclude patterns
          const excluded = excludePatterns.some((ep) =>
            minimatch ? minimatch(rel, ep, { dot: true }) : rel.includes("node_modules") || rel.startsWith(".git")
          );
          if (excluded) continue;

          if (e.isDirectory()) {
            walk(path.join(dir, e.name), rel);
          } else {
            const matches = minimatch
              ? minimatch(rel, pattern, { dot: true })
              : rel.endsWith(pattern.replace("**/*", "").replace("*", ""));
            if (matches) {
              results.push(rel);
            }
          }
        }
      };

      walk(searchDir, "");
      return { files: results, count: results.length, truncated: results.length >= maxResults, cwd: searchDir };
    } catch (err) {
      return { error: String(err), files: [], count: 0 };
    }
  },
});

// ---------------------------------------------------------------------------
// Grep search tool — T-CLI-GREP
// ---------------------------------------------------------------------------

export const grepSearchTool = tool({
  description:
    "Search for a pattern across files using grep-style matching. " +
    "Returns matching lines with file:line information. " +
    "Supports regex patterns.",
  inputSchema: z.object({
    pattern: z.string().describe("Search pattern (string or regex)"),
    cwd: z.string().optional().describe("Directory to search (default: current directory)"),
    filePattern: z.string().optional().describe("Glob pattern to filter files (e.g. '**/*.ts')"),
    isRegex: z.boolean().optional().default(false).describe("Treat pattern as a regex"),
    caseSensitive: z.boolean().optional().default(false).describe("Case-sensitive search"),
    maxResults: z.number().optional().default(50).describe("Maximum number of results"),
  }),
  execute: async ({ pattern, cwd, filePattern = "**/*", isRegex = false, caseSensitive = false, maxResults = 50 }) => {
    try {
      const searchDir = path.resolve(cwd ?? process.cwd());
      const flags = caseSensitive ? "g" : "gi";
      const regex = isRegex ? new RegExp(pattern, flags) : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);

      const matches: Array<{ file: string; line: number; text: string }> = [];

      const walk = (dir: string, base: string) => {
        if (matches.length >= maxResults) return;
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch { return; }

        for (const e of entries) {
          if (matches.length >= maxResults) break;
          const rel = base ? `${base}/${e.name}` : e.name;
          if (rel.includes("node_modules") || rel.startsWith(".git")) continue;

          if (e.isDirectory()) {
            walk(path.join(dir, e.name), rel);
          } else {
            // Skip binary files
            if (/\.(png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot|mp4|webm|zip|tar|gz|bin|exe|dll)$/i.test(e.name)) continue;
            try {
              const content = fs.readFileSync(path.join(dir, e.name), "utf-8");
              const lines = content.split("\n");
              for (let i = 0; i < lines.length && matches.length < maxResults; i++) {
                if (regex.test(lines[i] ?? "")) {
                  matches.push({ file: rel, line: i + 1, text: (lines[i] ?? "").trim().slice(0, 200) });
                  regex.lastIndex = 0;
                }
              }
            } catch { /* skip unreadable */ }
          }
        }
      };

      walk(searchDir, "");
      return { matches, count: matches.length, truncated: matches.length >= maxResults };
    } catch (err) {
      return { error: String(err), matches: [], count: 0 };
    }
  },
});

// ---------------------------------------------------------------------------
// LSP tools — Language Server Protocol integration
// ---------------------------------------------------------------------------

const LSP_BRIDGE = process.env["PAKALON_BRIDGE_URL"] ?? "http://localhost:7432";

async function lspPost(endpoint: string, body: object): Promise<any> {
  try {
    const resp = await fetch(`${LSP_BRIDGE}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`LSP bridge ${endpoint} → HTTP ${resp.status}`);
    return resp.json();
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

export const lspDefinitionTool = tool({
  description:
    "Go-to-definition: find where a symbol is defined. " +
    "Requires a language server (typescript-language-server, pyright, etc.) to be installed. " +
    "Returns file path(s) and line numbers of the definition.",
  inputSchema: z.object({
    filePath: z.string().describe("File containing the symbol"),
    line: z.number().describe("0-based line number of the symbol"),
    character: z.number().describe("0-based character offset of the symbol"),
    workspaceDir: z.string().optional().describe("Workspace root directory"),
  }),
  execute: async ({ filePath, line, character, workspaceDir }) => {
    return lspPost("/lsp/definition", { file_path: filePath, line, character, workspace_dir: workspaceDir ?? process.cwd() });
  },
});

export const lspReferencesTool = tool({
  description:
    "Find all references to a symbol across the workspace. " +
    "Requires a language server to be installed.",
  inputSchema: z.object({
    filePath: z.string(),
    line: z.number(),
    character: z.number(),
    workspaceDir: z.string().optional(),
  }),
  execute: async ({ filePath, line, character, workspaceDir }) => {
    return lspPost("/lsp/references", { file_path: filePath, line, character, workspace_dir: workspaceDir ?? process.cwd() });
  },
});

export const lspHoverTool = tool({
  description:
    "Get hover documentation for a symbol (type info, JSDoc, docstrings). " +
    "Requires a language server to be installed.",
  inputSchema: z.object({
    filePath: z.string(),
    line: z.number(),
    character: z.number(),
    workspaceDir: z.string().optional(),
  }),
  execute: async ({ filePath, line, character, workspaceDir }) => {
    return lspPost("/lsp/hover", { file_path: filePath, line, character, workspace_dir: workspaceDir ?? process.cwd() });
  },
});

export const lspCompletionTool = tool({
  description:
    "Get code completion suggestions at a position (IntelliSense). " +
    "Requires a language server to be installed. Returns top 20 completions.",
  inputSchema: z.object({
    filePath: z.string(),
    line: z.number(),
    character: z.number(),
    workspaceDir: z.string().optional(),
  }),
  execute: async ({ filePath, line, character, workspaceDir }) => {
    return lspPost("/lsp/completion", { file_path: filePath, line, character, workspace_dir: workspaceDir ?? process.cwd() });
  },
});

export const lspRenameTool = tool({
  description:
    "Rename a symbol across all files in the workspace. " +
    "Returns a WorkspaceEdit with all required changes. " +
    "Requires a language server to be installed.",
  inputSchema: z.object({
    filePath: z.string(),
    line: z.number(),
    character: z.number(),
    newName: z.string().describe("The new name for the symbol"),
    workspaceDir: z.string().optional(),
  }),
  execute: async ({ filePath, line, character, newName, workspaceDir }) => {
    return lspPost("/lsp/rename", { file_path: filePath, line, character, new_name: newName, workspace_dir: workspaceDir ?? process.cwd() });
  },
});

export const lspDiagnosticsTool = tool({
  description:
    "Get LSP diagnostics (errors, warnings, hints) for a file. " +
    "Returns inline error messages with line numbers. " +
    "Requires a language server to be installed.",
  inputSchema: z.object({
    filePath: z.string(),
    workspaceDir: z.string().optional(),
  }),
  execute: async ({ filePath, workspaceDir }) => {
    return lspPost("/lsp/diagnostics", { file_path: filePath, line: 0, character: 0, workspace_dir: workspaceDir ?? process.cwd() });
  },
});

export const lspSymbolsTool = tool({
  description:
    "Search workspace symbols by name (functions, classes, variables, etc.). " +
    "Returns symbol names with file locations. " +
    "Requires a language server to be installed.",
  inputSchema: z.object({
    query: z.string().describe("Symbol name to search for (partial match supported)"),
    workspaceDir: z.string().optional(),
    language: z.string().optional().describe("Limit search to a specific language (typescript, python, etc.)"),
  }),
  execute: async ({ query, workspaceDir, language }) => {
    return lspPost("/lsp/symbols", { query, workspace_dir: workspaceDir ?? process.cwd(), language });
  },
});

// ---------------------------------------------------------------------------
// Web Fetch tool — T-CLI-WEB-FETCH
// Fetches a URL and returns its content as markdown for AI context.
// Read-only: safe in all permission modes including plan mode.
// ---------------------------------------------------------------------------

const BRIDGE_URL = process.env["PAKALON_BRIDGE_URL"] ?? "http://localhost:7432";

export const webFetchTool = tool({
  description:
    "Fetch the content of a URL and return it as readable markdown text. " +
    "Useful for reading documentation, inspecting a web page, or pulling in reference content from the web. " +
    "Returns the page's main text extracted as markdown. " +
    "This is a read-only operation — safe in plan mode.",
  inputSchema: z.object({
    url: z.string().describe("The URL to fetch (must start with http:// or https://)"),
    formats: z.array(z.enum(["markdown", "html"])).optional().default(["markdown"]).describe("Content formats to return (default: markdown only)"),
    maxChars: z.number().optional().default(20000).describe("Maximum characters to return from the page content (default 20 000)"),
  }),
  execute: async ({ url, formats = ["markdown"], maxChars = 20000 }) => {
    try {
      if (!/^https?:\/\//i.test(url)) {
        return { error: "URL must begin with http:// or https://" };
      }
      const resp = await fetch(`${BRIDGE_URL}/scrape`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, formats }),
      });
      if (!resp.ok) {
        return { error: `Bridge /scrape returned HTTP ${resp.status}` };
      }
      const data: any = await resp.json();
      if (!data.success) {
        return { error: data.error ?? "Scrape failed", url };
      }
      const markdown = (data.markdown ?? "").slice(0, maxChars);
      return {
        url,
        markdown,
        truncated: (data.markdown ?? "").length > maxChars,
        source: data.source ?? "unknown",
      };
    } catch (err) {
      return { error: String(err), url };
    }
  },
});

// ---------------------------------------------------------------------------
// Web Search tool — T-CLI-WEB-SEARCH
// Searches the web and returns ranked results with snippets.
// Read-only: safe in all permission modes including plan mode.
// ---------------------------------------------------------------------------

export const webSearchTool = tool({
  description:
    "Search the web and return a list of relevant results with titles, URLs, and snippets. " +
    "Use this to find up-to-date information, research libraries, look up APIs, or verify facts. " +
    "This is a read-only operation — safe in plan mode.",
  inputSchema: z.object({
    query: z.string().describe("The web search query"),
    maxResults: z.number().optional().default(8).describe("Maximum number of results to return (default 8)"),
  }),
  execute: async ({ query, maxResults = 8 }) => {
    try {
      const resp = await fetch(`${BRIDGE_URL}/web/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, max_results: maxResults }),
      });
      if (!resp.ok) {
        return { error: `Bridge /web/search returned HTTP ${resp.status}` };
      }
      const data: any = await resp.json();
      if (!data.success) {
        return { error: data.error ?? "Search failed", query };
      }
      return {
        query,
        results: data.results ?? [],
        count: (data.results ?? []).length,
        source: data.source ?? "unknown",
      };
    } catch (err) {
      return { error: String(err), query };
    }
  },
});

// ---------------------------------------------------------------------------
// Todo Read / Write tools — T-CLI-TODO
// Per-session todo list stored in .pakalon/todos.json in the working directory.
// ---------------------------------------------------------------------------

interface TodoItem {
  id: number;
  content: string;
  /** "pending" | "in_progress" | "done" */
  status: "pending" | "in_progress" | "done";
  createdAt: string;
  updatedAt: string;
}

function _getTodosPath(): string {
  return path.join(process.cwd(), ".pakalon", "todos.json");
}

function _readTodosSync(): TodoItem[] {
  try {
    const todosPath = _getTodosPath();
    if (!fs.existsSync(todosPath)) return [];
    return JSON.parse(fs.readFileSync(todosPath, "utf-8")) as TodoItem[];
  } catch {
    return [];
  }
}

function _writeTodosSync(todos: TodoItem[]): void {
  const todosPath = _getTodosPath();
  const dir = path.dirname(todosPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(todosPath, JSON.stringify(todos, null, 2), "utf-8");
}

export const todoReadTool = tool({
  description:
    "Read the current todo list for this session/project. " +
    "Returns all todo items with their id, content, status (pending/in_progress/done), and timestamps. " +
    "Use this to check what tasks have been completed or are in progress. " +
    "This is a read-only operation — safe in plan mode.",
  inputSchema: z.object({
    statusFilter: z
      .enum(["all", "pending", "in_progress", "done"])
      .optional()
      .default("all")
      .describe("Filter todos by status (default: all)"),
  }),
  execute: async ({ statusFilter = "all" }) => {
    const todos = _readTodosSync();
    const filtered = statusFilter === "all" ? todos : todos.filter((t) => t.status === statusFilter);
    return {
      todos: filtered,
      total: todos.length,
      filtered: filtered.length,
      pending: todos.filter((t) => t.status === "pending").length,
      in_progress: todos.filter((t) => t.status === "in_progress").length,
      done: todos.filter((t) => t.status === "done").length,
    };
  },
});

export const todoWriteTool = tool({
  description:
    "Add, update, or delete todo items in the session todo list. " +
    "Use this to track tasks you plan to complete, mark tasks as in-progress when you start them, " +
    "and mark them done when finished. Todos persist across the session in .pakalon/todos.json.",
  inputSchema: z.object({
    operation: z.enum(["add", "update", "delete", "clear_done"]).describe(
      "Operation to perform: 'add' a new todo, 'update' status/content of an existing todo, 'delete' a todo by id, 'clear_done' removes all done todos"
    ),
    content: z.string().optional().describe("Todo content text (required for 'add'; optional for 'update')"),
    id: z.number().optional().describe("Todo id (required for 'update' and 'delete')"),
    status: z.enum(["pending", "in_progress", "done"]).optional().describe("New status (used with 'update')"),
  }),
  execute: async ({ operation, content, id, status }) => {
    const todos = _readTodosSync();
    const now = new Date().toISOString();

    switch (operation) {
      case "add": {
        if (!content?.trim()) return { error: "content is required for 'add'" };
        const newId = todos.length > 0 ? Math.max(...todos.map((t) => t.id)) + 1 : 1;
        const newTodo: TodoItem = {
          id: newId,
          content: content.trim(),
          status: "pending",
          createdAt: now,
          updatedAt: now,
        };
        todos.push(newTodo);
        _writeTodosSync(todos);
        return { success: true, operation: "add", todo: newTodo };
      }
      case "update": {
        if (id == null) return { error: "id is required for 'update'" };
        const idx = todos.findIndex((t) => t.id === id);
        if (idx === -1) return { error: `Todo id ${id} not found` };
        if (content) todos[idx]!.content = content.trim();
        if (status) todos[idx]!.status = status;
        todos[idx]!.updatedAt = now;
        _writeTodosSync(todos);
        return { success: true, operation: "update", todo: todos[idx] };
      }
      case "delete": {
        if (id == null) return { error: "id is required for 'delete'" };
        const before = todos.length;
        const remaining = todos.filter((t) => t.id !== id);
        if (remaining.length === before) return { error: `Todo id ${id} not found` };
        _writeTodosSync(remaining);
        return { success: true, operation: "delete", deleted_id: id };
      }
      case "clear_done": {
        const remaining = todos.filter((t) => t.status !== "done");
        const cleared = todos.length - remaining.length;
        _writeTodosSync(remaining);
        return { success: true, operation: "clear_done", cleared_count: cleared };
      }
      default:
        return { error: `Unknown operation: ${operation}` };
    }
  },
});

// ---------------------------------------------------------------------------
// Notebook Read / Edit tools — T-CLI-NOTEBOOK
// Read and edit Jupyter Notebook (.ipynb) files.
// ---------------------------------------------------------------------------

interface NotebookCell {
  cell_type: "code" | "markdown" | "raw";
  source: string[];
  metadata?: Record<string, unknown>;
  outputs?: unknown[];
  execution_count?: number | null;
}

interface JupyterNotebook {
  nbformat: number;
  nbformat_minor: number;
  metadata: Record<string, unknown>;
  cells: NotebookCell[];
}

export const notebookReadTool = tool({
  description:
    "Read a Jupyter Notebook (.ipynb) file and return its cells in a readable format. " +
    "Shows each cell's type (code/markdown/raw), source content, and any outputs. " +
    "Use this to understand, review, or plan edits to notebook files. " +
    "This is a read-only operation — safe in plan mode.",
  inputSchema: z.object({
    filePath: z.string().describe("Path to the .ipynb notebook file"),
    includeOutputs: z.boolean().optional().default(true).describe("Whether to include cell outputs (default: true)"),
    maxOutputChars: z.number().optional().default(500).describe("Max characters per cell output (default 500)"),
  }),
  execute: async ({ filePath, includeOutputs = true, maxOutputChars = 500 }) => {
    try {
      const abs = path.resolve(filePath);
      if (!fs.existsSync(abs)) return { error: `File not found: ${abs}` };
      const raw = fs.readFileSync(abs, "utf-8");
      const nb: JupyterNotebook = JSON.parse(raw);

      const cells = nb.cells.map((cell, idx) => {
        const source = cell.source.join("");
        const entry: Record<string, unknown> = {
          index: idx,
          type: cell.cell_type,
          source,
        };
        if (includeOutputs && cell.outputs && cell.outputs.length > 0) {
          const outputText = cell.outputs
            .map((o: any) => {
              if (o.output_type === "stream") return (o.text ?? []).join("").slice(0, maxOutputChars);
              if (o.output_type === "execute_result") return (o.data?.["text/plain"] ?? []).join("").slice(0, maxOutputChars);
              if (o.output_type === "error") return `${o.ename}: ${o.evalue}`;
              return `[${o.output_type} output]`;
            })
            .join("\n");
          entry.outputs = outputText;
        }
        if (cell.execution_count != null) {
          entry.execution_count = cell.execution_count;
        }
        return entry;
      });

      return {
        filePath: abs,
        nbformat: nb.nbformat,
        kernel: (nb.metadata as any)?.kernelspec?.name ?? "unknown",
        cell_count: nb.cells.length,
        cells,
      };
    } catch (err) {
      return { error: String(err) };
    }
  },
});

export const notebookEditTool = tool({
  description:
    "Edit a cell in a Jupyter Notebook (.ipynb) file, or insert/delete cells. " +
    "Changes are written back to disk. " +
    "Blocked in plan (read-only) mode.",
  inputSchema: z.object({
    filePath: z.string().describe("Path to the .ipynb notebook file"),
    operation: z.enum(["edit_cell", "insert_cell", "delete_cell"]).describe(
      "Operation: 'edit_cell' to change source of an existing cell, 'insert_cell' to add at an index, 'delete_cell' to remove by index"
    ),
    cellIndex: z.number().describe("0-based cell index (target for edit/delete; position for insert — new cell goes before this index; use -1 to append)"),
    source: z.string().optional().describe("New source content for the cell (required for edit_cell and insert_cell)"),
    cellType: z.enum(["code", "markdown", "raw"]).optional().default("code").describe("Cell type for insert_cell (default: code)"),
  }),
  execute: async ({ filePath, operation, cellIndex, source, cellType = "code" }) => {
    const { permissionMode } = useStore.getState();
    if (permissionMode === "plan") {
      return {
        error: "Notebook edit blocked: permission mode is 'plan'. Switch to 'edit' or 'auto-accept' to allow modifications.",
        blocked: true,
      };
    }

    try {
      const abs = path.resolve(filePath);
      if (!fs.existsSync(abs)) return { error: `File not found: ${abs}` };
      const raw = fs.readFileSync(abs, "utf-8");
      const nb: JupyterNotebook = JSON.parse(raw);
      const cells = nb.cells;

      switch (operation) {
        case "edit_cell": {
          if (source == null) return { error: "source is required for edit_cell" };
          const idx = cellIndex < 0 ? cells.length + cellIndex : cellIndex;
          if (idx < 0 || idx >= cells.length) return { error: `Cell index ${cellIndex} out of bounds (${cells.length} cells)` };
          cells[idx]!.source = source.split("\n").map((l, i, a) => (i < a.length - 1 ? l + "\n" : l));
          // Clear outputs when source changes
          if (cells[idx]!.cell_type === "code") {
            cells[idx]!.outputs = [];
            cells[idx]!.execution_count = null;
          }
          break;
        }
        case "insert_cell": {
          if (source == null) return { error: "source is required for insert_cell" };
          const newCell: NotebookCell = {
            cell_type: cellType,
            source: source.split("\n").map((l, i, a) => (i < a.length - 1 ? l + "\n" : l)),
            metadata: {},
            ...(cellType === "code" ? { outputs: [], execution_count: null } : {}),
          };
          const insertAt = cellIndex < 0 ? cells.length : Math.min(cellIndex, cells.length);
          cells.splice(insertAt, 0, newCell);
          break;
        }
        case "delete_cell": {
          const idx = cellIndex < 0 ? cells.length + cellIndex : cellIndex;
          if (idx < 0 || idx >= cells.length) return { error: `Cell index ${cellIndex} out of bounds (${cells.length} cells)` };
          cells.splice(idx, 1);
          break;
        }
        default:
          return { error: `Unknown operation: ${operation}` };
      }

      fs.writeFileSync(abs, JSON.stringify(nb, null, 1), "utf-8");
      return { success: true, operation, filePath: abs, cell_count: cells.length };
    } catch (err) {
      return { error: String(err) };
    }
  },
});
export const allTools = {
  readFile: readFileTool,
  writeFile: writeFileTool,
  listDir: listDirTool,
  bash: bashTool,
  imageAnalysis: imageAnalysisTool,
  videoAnalysis: videoAnalysisTool,
  generateImage: generateImageTool,
  generateVideo: generateVideoTool,
  uploadFile: uploadFileTool,
  downloadFile: downloadFileTool,
  listFiles: listFilesTool,
  deleteFile: deleteFileTool,
  editFile: editFileTool,
  multiEditFiles: multiEditFilesTool,
  globFind: globFindTool,
  grepSearch: grepSearchTool,
  lspDefinition: lspDefinitionTool,
  lspReferences: lspReferencesTool,
  lspHover: lspHoverTool,
  lspCompletion: lspCompletionTool,
  lspRename: lspRenameTool,
  lspDiagnostics: lspDiagnosticsTool,
  lspSymbols: lspSymbolsTool,
  webFetch: webFetchTool,
  webSearch: webSearchTool,
  todoRead: todoReadTool,
  todoWrite: todoWriteTool,
  notebookRead: notebookReadTool,
  notebookEdit: notebookEditTool,
};
