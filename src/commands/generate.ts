/**
 * /generate command — AI image generation (Pro feature).
 * T-IMG-01: Calls the Python image_gen bridge tool.
 *
 * Usage:
 *   /generate <prompt>
 *   /generate <prompt> --size 1792x1024 --quality hd --style vivid
 *   pakalon generate "A minimalist SaaS dashboard" --size 1792x1024
 */
import path from "path";
import { getApiClient } from "@/api/client.js";
import { useStore } from "@/store/index.js";
import logger from "@/utils/logger.js";

export interface GenerateImageOptions {
  prompt: string;
  size?: "1024x1024" | "1792x1024" | "1024x1792";
  quality?: "standard" | "hd";
  style?: "natural" | "vivid";
  /** Project directory (default: cwd) */
  projectDir?: string;
  /** If true, print result path to stdout (non-TUI mode) */
  printMode?: boolean;
}

export interface GenerateImageResult {
  ok: boolean;
  url?: string;
  localPath?: string;
  provider?: string;
  prompt?: string;
  size?: string;
  error?: string;
  planBlocked?: boolean;
}

/**
 * Generate an AI image via the backend bridge.
 * Returns the result with url and local path.
 */
export async function cmdGenerateImage(
  opts: GenerateImageOptions
): Promise<GenerateImageResult> {
  const { prompt, size = "1024x1024", quality = "standard", style = "natural", projectDir } = opts;

  if (!prompt || prompt.trim().length < 3) {
    return { ok: false, error: "Please provide a description (3+ chars) for the image." };
  }

  try {
    const api = getApiClient();
    const res = await api.post<{
      ok: boolean;
      url?: string;
      local_path?: string;
      provider?: string;
      revised_prompt?: string;
      size?: string;
      error?: string;
      plan_blocked?: boolean;
    }>("/tools/generate-image", {
      prompt: prompt.trim(),
      size,
      quality,
      style,
      project_dir: projectDir ?? process.cwd(),
    });

    const d = res.data;

    if (d.plan_blocked) {
      return {
        ok: false,
        planBlocked: true,
        error:
          "🔒 Image generation is a Pro-only feature.\n" +
          "Upgrade at https://pakalon.com/pricing to unlock it.",
      };
    }

    if (!d.ok || d.error) {
      return { ok: false, error: d.error ?? "Image generation failed." };
    }

    return {
      ok: true,
      url: d.url,
      localPath: d.local_path,
      provider: d.provider,
      prompt: d.revised_prompt ?? prompt,
      size: d.size,
    };
  } catch (err: unknown) {
    // Fallback: call Python directly via bridge if API route unavailable
    logger.warn("[generate] API route failed, trying Python bridge", { err: String(err) });
    return _callPythonBridge(opts);
  }
}

/** Fallback: spawn Python tool directly (development / offline mode). */
async function _callPythonBridge(opts: GenerateImageOptions): Promise<GenerateImageResult> {
  return new Promise((resolve) => {
    const { spawnSync } = require("child_process") as typeof import("child_process");
    const { prompt, size = "1024x1024", quality = "standard", style = "natural", projectDir } = opts;

    const toolsDir = path.resolve(__dirname ?? ".", "../../python/tools").replace(/\\/g, "\\\\");
    const scriptCode = [
      "import sys, json",
      `sys.path.insert(0, '${toolsDir}')`,
      "from image_gen import ImageGenTool",
      `tool = ImageGenTool(user_plan='pro', project_dir='${(projectDir ?? process.cwd()).replace(/\\/g, "\\\\")}')`,
      `result = tool.generate(${JSON.stringify(prompt)}, size=${JSON.stringify(size)}, quality=${JSON.stringify(quality)}, style=${JSON.stringify(style)})`,
      "print(json.dumps(result))",
    ].join("\n");

    const result = spawnSync("python", ["-c", scriptCode], {
      encoding: "utf-8",
      timeout: 90_000,
      env: { ...process.env },
    });

    if (result.error || result.status !== 0) {
      resolve({ ok: false, error: `Python bridge error: ${result.stderr ?? result.error}` });
      return;
    }

    try {
      const parsed = JSON.parse(result.stdout ?? "{}") as {
        url?: string;
        local_path?: string;
        provider?: string;
        prompt?: string;
        size?: string;
      };
      resolve({
        ok: true,
        url: parsed.url,
        localPath: parsed.local_path,
        provider: parsed.provider,
        prompt: parsed.prompt,
        size: parsed.size,
      });
    } catch (e) {
      resolve({ ok: false, error: `Parse error: ${String(e)}` });
    }
  });
}

/**
 * Print-mode handler: called from yargs `pakalon generate "<prompt>"`.
 */
export async function cmdGeneratePrint(prompt: string, opts: Omit<GenerateImageOptions, "prompt">): Promise<void> {
  console.log(`\n🎨 Generating image: "${prompt}" …\n`);
  const result = await cmdGenerateImage({ prompt, ...opts });

  if (!result.ok) {
    if (result.planBlocked) {
      console.error(result.error);
    } else {
      console.error(`❌ ${result.error}`);
    }
    process.exit(1);
  }

  console.log(`✅ Image generated!`);
  if (result.provider) console.log(`   Provider  : ${result.provider}`);
  if (result.prompt) console.log(`   Prompt    : ${result.prompt}`);
  if (result.size) console.log(`   Size      : ${result.size}`);
  if (result.url) console.log(`   URL       : ${result.url}`);
  if (result.localPath) console.log(`   Saved to  : ${result.localPath}`);
  console.log();
}
