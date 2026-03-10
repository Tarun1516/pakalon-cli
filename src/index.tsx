#!/usr/bin/env bun
/**
 * Pakalon CLI entry point — yargs command parser + Ink renderer.
 */
import React from "react";
import { render } from "ink";
import path from "path";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import App from "@/app.js";
import BuildScreen from "@/components/screens/BuildScreen.js";
import SplashLoginScreen from "@/frontend/screens/SplashLoginScreen.js";
import { logout } from "@/auth/device-flow.js";
import { isAuthenticated } from "@/auth/storage.js";
import { cmdListModels, cmdSetModel, formatModelsTable } from "@/commands/model.js";
import { cmdGeneratePrint } from "@/commands/generate.js";
import { cmdEnterprisePrint } from "@/commands/enterprise.js";
import type { EnterpriseService, EnterpriseAction } from "@/commands/enterprise.js";
import { cmdListSessions, cmdCreateSession, cmdResumeSession } from "@/commands/session.js";
import { cmdStatus, formatStatus } from "@/commands/status.js";
import { cmdUpgrade } from "@/commands/upgrade.js";
import { cmdDoctor } from "@/commands/doctor.js";
import { cmdInstall } from "@/commands/install.js";
import { cmdSetupToken } from "@/commands/setup-token.js";
import { cmdUpdateCli } from "@/commands/update-cli.js";
import { addMcpServer, removeMcpServer, listMcpServers, installMcpServer, discoverMcpServers, uninstallMcpServer } from "@/mcp/manager.js";
import { searchRegistry } from "@/mcp/registry.js";
import { cmdHistory } from "@/commands/history.js";
import { getAllAgents } from "@/commands/agents.js";
import { cmdDirectory } from "@/commands/directory.js";
import { cmdListWorkflows, cmdSaveWorkflow, cmdDeleteWorkflow } from "@/commands/workflows.js";
import { cmdListPlugins, cmdInstallPlugin, cmdRemovePlugin, cmdCheckUpdates, cmdAutoUpdate, cmdListMarketplace } from "@/commands/plugins.js";
import { cmdSecurity } from "@/commands/security.js";
import { cmdTrace } from "@/commands/trace.js";
import { cachePrContext, formatPrContextForPrompt } from "@/utils/github-pr.js";
import { runPrintMode, readStdin, buildSystemPrompt } from "@/utils/print-mode.js";
import type { OutputFormat } from "@/utils/print-mode.js";
import logger from "@/utils/logger.js";
import { EXIT_SUCCESS, EXIT_AUTH_ERROR, EXIT_API_ERROR } from "@/utils/exit-codes.js";
import { initTelemetry, shutdownTelemetry } from "@/utils/telemetry.js";

async function main() {
  // T-CLI-OTEL: initialise OpenTelemetry when PAKALON_ENABLE_TELEMETRY=1
  await initTelemetry();
  const argv = await yargs(hideBin(process.argv))
    .scriptName("pakalon")
    .usage("$0 [message]  Start a chat session")
    .command(
      "$0 [message]",
      "Start a chat (or send a one-shot message)",
      (y) =>
        y
          .positional("message", { type: "string", describe: "Message to send directly" })
          .option("agent", { alias: "a", type: "boolean", describe: "Start in agent mode" })
          .option("dir", { alias: "d", type: "string", describe: "Project directory" })
          .option("no-banner", { type: "boolean", describe: "Hide the banner" })
          .option("permission-mode", { type: "string", choices: ["plan", "normal", "auto-accept", "orchestration", "edit", "bypass"] as const, describe: "Permission mode: plan, normal (ask first), auto-accept, orchestration (Q&A only)" })
          .option("plan", { type: "boolean", describe: "Start in plan (read-only) mode" })
          .option("edit", { type: "boolean", describe: "Start in normal mode (ask before actions)" })
          .option("auto-accept", { type: "boolean", describe: "Start in auto-accept mode" })
          .option("bypass-permissions", { type: "boolean", describe: "Start in bypass mode (YOLO — no confirmations)" })
          .option("model", { alias: "m", type: "string", describe: "Model to use" })
          .option("defaultModel", { type: "string", describe: "Default model to use" })
          .option("fallbackModel", { type: "string", describe: "Fallback model when default fails" })
          .option("verbose", { type: "boolean", describe: "Verbose output mode" })
          .option("debug", { type: "boolean", describe: "Enable debug logging" })
          .option("session-id", { type: "string", describe: "Resume a specific session" })
          .option("add-dir", { type: "array", string: true, describe: "Additional project directories to include in context" })
          .option("allowedTools", { type: "string", describe: "Comma-separated list of allowed tool names" })
          .option("MCP", { type: "array", string: true, describe: "Additional MCP server URLs to connect on startup" })
          .option("fork-session", { type: "boolean", default: false, describe: "Fork the current session into a new one" })
          .option("replay-user-messages", { type: "boolean", default: false, describe: "Replay persisted user messages from the last session" })
          .option("continue", { alias: "c", type: "boolean", default: false, describe: "Resume the most recent session (same as --session-id with last id)" })
          .option("file", { type: "array", string: true, describe: "File(s) to inject as context at startup (paths relative to cwd)" })
          .option("settings", { type: "string", describe: "Path to a JSON settings file (overrides env defaults)" })
          .option("max-budget-usd", { type: "number", describe: "Maximum spend budget in USD; stops generation when exceeded" })
          .option("mcp-config", { type: "string", describe: "Path to an extra MCP server config JSON file to load on startup" })
          // ── Claude Code–parity flags ──────────────────────────────────────
          .option("print", { alias: "p", type: "boolean", default: false, describe: "Non-interactive: stream response to stdout without TUI and exit" })
          .option("output-format", { type: "string", choices: ["text", "json", "stream-json"] as const, default: "text", describe: "Output format for --print mode (text | json | stream-json)" })
          .option("system-prompt", { type: "string", describe: "Override the default system prompt" })
          .option("system-prompt-file", { type: "string", describe: "Read system prompt from a file" })
          .option("append-system-prompt", { type: "string", describe: "Append text after the default system prompt" })
          .option("append-system-prompt-file", { type: "string", describe: "Append file contents after the default system prompt" })
          .option("disable-slash-commands", { type: "boolean", default: false, describe: "Disable slash-command parsing in the TUI" })
          .option("disallowed-tools", { type: "string", describe: "Comma-separated list of tool names to disallow" })
          .option("input-format", { type: "string", choices: ["text", "json"] as const, default: "text", describe: "Format of the message argument (text or JSON messages array)" })
          .option("mcp-debug", { type: "boolean", default: false, describe: "Enable MCP server debugging output" })
          .option("debug-file", { type: "string", describe: "Path to debug log file" })
          .option("setting-sources", { type: "string", choices: ["env", "file", "cli"] as const, describe: "Source for settings: env, file, or cli" }),
      async (args) => {
        if (args.debug) {
          process.env["PAKALON_DEBUG"] = "1";
        }

        // ── stdin piping: read piped content and prepend to message ──────────
        const stdinContent = await readStdin();
        let finalMessage = args.message ?? "";
        if (stdinContent) {
          finalMessage = stdinContent + (finalMessage ? `\n\n${finalMessage}` : "");
        }

        // ── --print / -p mode: non-interactive one-shot output ───────────────
        if ((args as any).print || (args as any).p) {
          if (!finalMessage) {
            process.stderr.write("Error: a message is required in --print mode.\n");
            process.exit(1);
          }
          await runPrintMode({
            message: finalMessage,
            model: args.model,
            systemPrompt: args["system-prompt"] as string | undefined,
            systemPromptFile: args["system-prompt-file"] as string | undefined,
            appendSystemPrompt: args["append-system-prompt"] as string | undefined,
            appendSystemPromptFile: args["append-system-prompt-file"] as string | undefined,
            outputFormat: ((args as any)["output-format"] as OutputFormat) ?? "text",
          });
          process.exit(EXIT_SUCCESS);
        }

        // ── --betas: enable experimental feature flags via env vars ─────────
        const betaFlags: string[] = ((args as any)["betas"] as string | undefined)
          ?.split(",")
          .map((f: string) => f.trim().toLowerCase())
          .filter(Boolean) ?? [];
        for (const flag of betaFlags) {
          const envKey = `PAKALON_BETA_${flag.toUpperCase().replace(/-/g, "_")}`;
          process.env[envKey] = "1";
        }

        // ── --ide: set IDE integration mode env var ───────────────────────────
        const ideMode = (args as any)["ide"] as string | undefined;
        if (ideMode && ideMode !== "none") {
          process.env["PAKALON_IDE_MODE"] = ideMode;
        }

        // ── --teammate-mode: forces plan (read-only) + teammate indicator ─────
        const isTeammateMode = Boolean((args as any)["teammate-mode"]);

        // ── --worktree: create/reuse a git worktree and use it as projectDir ──
        let resolvedProjectDir = args.dir ?? process.cwd();
        const worktreePath = (args as any)["worktree"] as string | undefined;
        if (worktreePath) {
          const { execSync: _exec } = await import("child_process");
          const { existsSync: _exists } = await import("fs");
          const abs = path.resolve(worktreePath);
          try {
            if (!_exists(abs)) {
              const branch = `pakalon-wt-${Date.now()}`;
              _exec(`git worktree add "${abs}" -b "${branch}"`, {
                cwd: resolvedProjectDir,
                stdio: "pipe",
              });
              process.stderr.write(`✓ Created git worktree at ${abs}\n`);
              // T-HK-11: Fire WorktreeCreate hook
              try {
                const { runHooks: _runHooks } = await import("@/ai/hooks.js");
                _runHooks("WorktreeCreate", {
                  cwd: resolvedProjectDir,
                  toolInput: { path: abs, branch },
                }, resolvedProjectDir).catch(() => {});
              } catch { /* non-fatal */ }
            } else {
              process.stderr.write(`✓ Using worktree at ${abs}\n`);
            }
            resolvedProjectDir = abs;
          } catch (wtErr: unknown) {
            const msg = wtErr instanceof Error ? wtErr.message : String(wtErr);
            process.stderr.write(`⚠ Worktree setup failed (${msg}), falling back to ${resolvedProjectDir}\n`);
          }
          // T-HK-11: Fire WorktreeRemove hook on process exit
          const _origDir = resolvedProjectDir;
          const _worktreeAbs = path.resolve(worktreePath);
          const _onExit = () => {
            try {
              const { runHooks: _rh } = require("@/ai/hooks.js") as typeof import("@/ai/hooks.js");
              _rh("WorktreeRemove", {
                cwd: _origDir,
                toolInput: { path: _worktreeAbs },
              }, _origDir).catch(() => {});
            } catch { /* non-fatal */ }
          };
          process.once("exit", _onExit);
          process.once("SIGINT", _onExit);
          process.once("SIGTERM", _onExit);
        }

        const projectDir = resolvedProjectDir;
        await render(
          React.createElement(App, {
            initialMessage: finalMessage || undefined,
            projectDir,
            forceAgent: args.agent ?? false,
            showBanner: args["no-banner"] ? false : true,
            permissionMode: (
              isTeammateMode ? "plan" :
              args["plan"] ? "plan" :
              args["edit"] ? "normal" :
              args["auto-accept"] ? "auto-accept" :
              args["bypass-permissions"] ? "auto-accept" :
              args["permission-mode"] as "plan" | "normal" | "auto-accept" | "orchestration" | "edit" | "bypass" | undefined
            ),
            modelOverride: args.model,
            defaultModel: args.defaultModel,
            fallbackModel: args.fallbackModel,
            sessionIdOverride: args["session-id"],
            addDirs: (args["add-dir"] as string[] | undefined) ?? [],
            allowedTools: args.allowedTools ?? undefined,
            mcpServers: (args["MCP"] as string[] | undefined) ?? [],
            forkSession: args["fork-session"] ?? false,
            replayUserMessages: args["replay-user-messages"] ?? false,
            continueSession: args["continue"] ?? false,
            fileContexts: (args["file"] as string[] | undefined) ?? [],
            settingsFile: args["settings"] as string | undefined,
            maxBudgetUsd: args["max-budget-usd"] as number | undefined,
            mcpConfigFile: args["mcp-config"] as string | undefined,
            disableSlashCommands: (args as any)["disable-slash-commands"] ?? false,
            systemPrompt: buildSystemPrompt({
              systemPrompt: args["system-prompt"] as string | undefined,
              systemPromptFile: args["system-prompt-file"] as string | undefined,
              appendSystemPrompt: args["append-system-prompt"] as string | undefined,
              appendSystemPromptFile: args["append-system-prompt-file"] as string | undefined,
            }) || undefined,
            fromPr: args["from-pr"] as string | undefined,
            ideMode: ideMode ?? undefined,
            teammateMode: isTeammateMode,
            betas: betaFlags,
          })
        ).waitUntilExit();
      }
    )
    .command("login", "Authenticate with GitHub via device code", {}, async () => {
      let unmountFn: (() => void) | undefined;

      await new Promise<void>((resolve, reject) => {
        const { unmount, waitUntilExit } = render(
          React.createElement(SplashLoginScreen, {
            showAnimation: false,
            onAuthenticated: () => {
              unmountFn?.();
              resolve();
            },
          })
        );
        unmountFn = unmount;
        waitUntilExit().catch(reject);
      });
      process.exit(EXIT_SUCCESS);
    })
    .command("logout", "Log out and clear credentials", {}, async () => {
      await logout();
      console.log("✓ Logged out");
      process.exit(EXIT_SUCCESS);
    })
    .command(
      "model [action] [id]",
      "List or set the active model",
      (y) =>
        y
          .positional("action", { type: "string", choices: ["list", "set"] as const, default: "list" })
          .positional("id", { type: "string", describe: "Model ID (for set)" }),
      async (args) => {
        if (!isAuthenticated()) {
          console.error("Not logged in. Run `pakalon login` first.");
          process.exit(EXIT_AUTH_ERROR);
        }
        try {
          if (args.action === "set" && args.id) {
            await cmdSetModel(args.id);
            console.log(`✓ Model set to ${args.id}`);
          } else {
            // T-CLI-15: Show remaining context % for each model
            const models = await cmdListModels();
            console.log(formatModelsTable(models));
          }
        } catch (err) {
          console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
          process.exit(EXIT_API_ERROR);
        }
        process.exit(EXIT_SUCCESS);
      }
    )
    .command("status", "Show account and trial status", {}, async () => {
      if (!isAuthenticated()) {
        console.error("Not logged in. Run `pakalon login` first.");
        process.exit(EXIT_AUTH_ERROR);
      }
      try {
        const info = await cmdStatus();
        console.log(formatStatus(info));
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(EXIT_API_ERROR);
      }
      process.exit(EXIT_SUCCESS);
    })
    .command("upgrade", "Upgrade to Pakalon Pro", {}, async () => {
      if (!isAuthenticated()) {
        console.error("Not logged in. Run `pakalon login` first.");
        process.exit(EXIT_AUTH_ERROR);
      }
      try {
        const url = await cmdUpgrade();
        console.log(`\n→ Open this URL to upgrade:\n  ${url}\n`);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(EXIT_API_ERROR);
      }
      process.exit(EXIT_SUCCESS);
    })
    .command(
      "session [action] [id]",
      "Manage chat sessions",
      (y) =>
        y
          .positional("action", {
            type: "string",
            choices: ["list", "new", "clear", "resume"] as const,
            default: "list",
          })
          .positional("id", { type: "string", describe: "Session ID (for resume)" }),
      async (args) => {
        if (!isAuthenticated()) {
          console.error("Not logged in.");
          process.exit(EXIT_AUTH_ERROR);
        }
        try {
          if (args.action === "new") {
            const s = await cmdCreateSession();
            console.log(`✓ New session: ${s.id}`);
          } else if (args.action === "resume") {
            const id = await cmdResumeSession(args.id);
            console.log(id ? `✓ Resumed session: ${id}` : "No sessions found to resume.");
          } else if (args.action === "list") {
            const sessions = await cmdListSessions();
            for (const s of sessions) {
              console.log(`  ${s.id}  ${s.title ?? "(untitled)"}  [${s.mode}]  ${s.created_at.slice(0, 10)}`);
            }
          }
        } catch (err) {
          console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
          process.exit(EXIT_API_ERROR);
        }
        process.exit(EXIT_SUCCESS);
      }
    )
    .command("history", "Show session history", (y) =>
      y
        .option("limit", { type: "number", default: 20, describe: "Max sessions to show" })
        .option("dir", { alias: "d", type: "string", describe: "Filter by project directory" })
        .option("json-schema", { type: "boolean", default: false, describe: "Output full JSON array" })
        .option("include-partial-messages", { type: "boolean", default: false, describe: "Include sessions with incomplete messages" }),
      async (args) => {
        if (!isAuthenticated()) { console.error("Not logged in."); process.exit(EXIT_AUTH_ERROR); }
        await cmdHistory(args.limit, {
          projectDir: args.dir,
          jsonSchema: args["json-schema"],
          includePartialMessages: args["include-partial-messages"],
        });
        process.exit(EXIT_SUCCESS);
      }
    )
    .command(
      "agents [action] [name]",
      "List or inspect saved agent configurations",
      (y) =>
        y
          .positional("action", { type: "string", choices: ["list"] as const, default: "list" })
          .positional("name", { type: "string", describe: "Agent name" }),
      async (args) => {
        const agents = getAllAgents();
        if (!agents.length) { console.log("No saved agents."); process.exit(EXIT_SUCCESS); }
        for (const a of agents) {
          console.log(`  ${a.name.padEnd(30)} ${a.description ?? ""}`);
        }
        process.exit(EXIT_SUCCESS);
      }
    )
    .command(
      "directory [path]",
      "Show project directory tree",
      (y) => y.positional("path", { type: "string", describe: "Directory path" }),
      async (args) => {
        cmdDirectory(args.path ?? process.cwd());
        process.exit(EXIT_SUCCESS);
      }
    )
    .command(
      "plugins [action] [package]",
      "Manage Pakalon plugins",
      (y) =>
        y
          .positional("action", { type: "string", choices: ["list", "install", "remove", "check", "update", "marketplace"] as const, default: "list" })
          .positional("package", { type: "string", describe: "Package name or search query" })
          .option("yes", { alias: "y", type: "boolean", describe: "Skip changelog confirmation prompt" }),
      async (args) => {
        const action = args.action ?? "list";
        if (action === "install") {
          if (!args.package) { console.error("Package name required."); process.exit(1); }
          await cmdInstallPlugin(args.package);
        } else if (action === "remove") {
          if (!args.package) { console.error("Package name required."); process.exit(1); }
          cmdRemovePlugin(args.package);
        } else if (action === "check") {
          await cmdCheckUpdates();
        } else if (action === "update") {
          await cmdAutoUpdate(args.package, { yes: args.yes });
        } else if (action === "marketplace") {
          await cmdListMarketplace(args.package);
        } else {
          cmdListPlugins();
        }
        process.exit(EXIT_SUCCESS);
      }
    )
    .command(
      "workflows [action] [name]",
      "Manage saved prompt workflows",
      (y) =>
        y
          .positional("action", { type: "string", choices: ["list", "save", "delete"] as const, default: "list" })
          .positional("name", { type: "string", describe: "Workflow name" })
          .option("description", { alias: "d", type: "string", default: "" })
          .option("prompts", { type: "array", string: true, describe: "Prompts to save", default: [] as string[] }),
      async (args) => {
        const action = args.action ?? "list";
        if (action === "save") {
          if (!args.name) { console.error("Workflow name required."); process.exit(1); }
          cmdSaveWorkflow(args.name, args.description ?? "", args.prompts as string[]);
          console.log(`✓ Workflow saved: ${args.name}`);
        } else if (action === "delete") {
          if (!args.name) { console.error("Workflow name required."); process.exit(1); }
          cmdDeleteWorkflow(args.name);
          console.log(`✓ Workflow deleted: ${args.name}`);
        } else {
          cmdListWorkflows();
        }
        process.exit(EXIT_SUCCESS);
      }
    )
    .command("doctor", "Check system requirements and diagnose issues", {}, async () => {
      await cmdDoctor();
    })
    .command("install", "Install Python bridge and dependencies", {}, async () => {
      await cmdInstall();
    })
    .command("setup-token", "Set authentication token manually (CI/CD)", {}, async () => {
      await cmdSetupToken();
    })
    .command(
      "update",
      "Update Pakalon CLI to the latest version",
      (y) => y.option("yes", { alias: "y", type: "boolean", describe: "Skip confirmation prompt" }),
      async (args) => {
        await cmdUpdateCli({ yes: args.yes });
      }
    )
    .command(
      "mcp [action]",
      "Manage Model Context Protocol servers",
      (y) =>
        y
          .positional("action", {
            type: "string",
            choices: ["list", "add", "remove", "search", "install", "discover", "uninstall"] as const,
            default: "list",
          })
          .option("name", { type: "string", describe: "Server name" })
          .option("url", { type: "string", describe: "Server URL" })
          .option("scope", {
            type: "string",
            choices: ["global", "project"] as const,
            default: "global",
            describe: "Config scope",
          })
          .option("query", { alias: "q", type: "string", describe: "Search query" }),
      async (args) => {
        const action = args.action ?? "list";

        if (action === "list") {
          const servers = listMcpServers();
          if (servers.length === 0) {
            console.log("\nNo MCP servers configured.");
            console.log('Add one: pakalon mcp add --name github --url <url> --scope global\n');
          } else {
            console.log(`\n── MCP Servers (${servers.length}) ─────────────────────\n`);
            for (const s of servers) {
              console.log(`  [${s.scope}] ${s.name.padEnd(25)} ${s.url}`);
            }
            console.log();
          }
        } else if (action === "add") {
          if (!args.name || !args.url) {
            console.error("--name and --url are required for mcp add");
            process.exit(1);
          }
          const result = await addMcpServer(args.name, args.url, args.scope as "global" | "project");
          console.log(result.message);
          if (!result.ok) process.exit(1);
        } else if (action === "remove") {
          if (!args.name) {
            console.error("--name is required for mcp remove");
            process.exit(1);
          }
          const result = removeMcpServer(args.name, args.scope as "global" | "project");
          console.log(result.message);
          if (!result.ok) process.exit(1);
        } else if (action === "search") {
          const query = args.query ?? args.name ?? "";
          const results = searchRegistry(query);
          if (results.length === 0) {
            console.log(`No MCP servers found for "${query}"`);
          } else {
            console.log(`\n── Registry Results for "${query}" ─────────────\n`);
            for (const r of results.slice(0, 10)) {
              const badge = r.official ? "[official]" : "[community]";
              console.log(`  ${r.name.padEnd(25)} ${badge.padEnd(12)} ${r.description}`);
            }
            console.log("\nInstall with: pakalon mcp install <name>\n");
          }
        } else if (action === "install") {
          const nameOrPkg = args.name ?? args.query;
          if (!nameOrPkg) { console.error("--name or a positional package name is required."); process.exit(1); }
          const result = await installMcpServer(nameOrPkg, args.scope as "global" | "project", { url: args.url });
          console.log(result.message);
          if (!result.ok) process.exit(1);
        } else if (action === "discover") {
          const query = args.query ?? "";
          const entries = await discoverMcpServers(query);
          if (entries.length === 0) {
            console.log(`No MCP servers found${query ? ` for "${query}"` : ""}.`);
          } else {
            console.log(`\n── Available MCP Servers${query ? ` matching "${query}"` : ""} ─────────────\n`);
            for (const e of entries.slice(0, 25)) {
              const inst = e.installedVersion ? ` [installed v${e.installedVersion}]` : "";
              console.log(`  ${e.name.padEnd(25)} ${(e.tags ?? []).join(", ").padEnd(20)}${inst}`);
              console.log(`    ${e.description}`);
              console.log();
            }
            console.log("Install with: pakalon mcp install <name>\n");
          }
        } else if (action === "uninstall") {
          if (!args.name) { console.error("--name is required for mcp uninstall"); process.exit(1); }
          const result = await uninstallMcpServer(args.name, args.scope as "global" | "project", { removePackage: true });
          console.log(result.message);
          if (!result.ok) process.exit(1);
        }
        process.exit(EXIT_SUCCESS);
      }
    )
    .command(
      "build [prompt]",
      "Run the 6-phase agentic build pipeline (T-CLI-03, T-CLI-04, T-CLI-11)",
      (y) =>
        y
          .positional("prompt", { type: "string", describe: "What to build" })
          .option("phase", { alias: "p", type: "number", default: 1, describe: "Start from phase (1-6)" })
          .option("dir", { alias: "d", type: "string", describe: "Project directory" })
          .option("yolo", { type: "boolean", default: false, describe: "YOLO mode — skip confirmations" })
          .option("figma", { type: "string", describe: "Figma URL (Phase 1)" })
          .option("target", { type: "string", default: "http://localhost:3000", describe: "Target URL for Phase 4 DAST" }),
      async (args) => {
        if (!isAuthenticated()) {
          console.error("Not logged in. Run `pakalon login` first.");
          process.exit(EXIT_AUTH_ERROR);
        }
        const projectDir = args.dir ?? process.cwd();
        await render(
          React.createElement(BuildScreen, {
            projectDir,
            userPrompt: args.prompt ?? "",
            phase: args.phase ?? 1,
            isYolo: args.yolo ?? false,
            figmaUrl: args.figma,
            targetUrl: args.target,
          })
        ).waitUntilExit();
      }
    )
    .command(
      "generate <prompt>",
      "Generate an AI image from a text description (Pro feature)",
      (y) =>
        y
          .positional("prompt", { type: "string", describe: "Image description" })
          .option("size", {
            type: "string",
            choices: ["1024x1024", "1792x1024", "1024x1792"] as const,
            default: "1024x1024",
            describe: "Image dimensions",
          })
          .option("quality", {
            type: "string",
            choices: ["standard", "hd"] as const,
            default: "standard",
            describe: "Image quality (hd uses more tokens)",
          })
          .option("style", {
            type: "string",
            choices: ["natural", "vivid"] as const,
            default: "natural",
            describe: "Generation style",
          })
          .option("dir", { alias: "d", type: "string", describe: "Project directory (output path)" }),
      async (args) => {
        if (!args.prompt) {
          console.error('Usage: pakalon generate "<description>"');
          process.exit(1);
        }
        await cmdGeneratePrint(args.prompt, {
          size: args.size as "1024x1024" | "1792x1024" | "1024x1792",
          quality: args.quality as "standard" | "hd",
          style: args.style as "natural" | "vivid",
          projectDir: args.dir ?? process.cwd(),
        });
        process.exit(EXIT_SUCCESS);
      }
    )

    // ── enterprise <service> <action> ───────────────────────────────────────
    .command(
      "enterprise <service> <action>",
      "Manage enterprise integrations (Notion, Jira)",
      (yargs) =>
        yargs
          .positional("service", {
            type: "string",
            choices: ["notion", "jira"] as const,
            describe: "Enterprise service to configure",
          })
          .positional("action", {
            type: "string",
            choices: ["setup", "remove", "status"] as const,
            describe: "Action to perform",
          })
          .option("token", { alias: "t", type: "string", describe: "API token / PAT" })
          .option("workspace", { alias: "w", type: "string", describe: "Workspace name / Atlassian subdomain" })
          .option("email", { alias: "e", type: "string", describe: "User email (Jira Cloud)" })
          .option("server", { type: "string", describe: "Jira Server/DC URL" })
          .option("scope", {
            type: "string",
            choices: ["global", "project"] as const,
            default: "global",
            describe: "MCP server scope",
          }),
      async (args) => {
        await cmdEnterprisePrint(
          args.service as EnterpriseService,
          args.action as EnterpriseAction,
          {
            token: args.token,
            workspace: args.workspace,
            email: args.email,
            server: args.server,
            scope: (args.scope as "global" | "project") ?? "global",
            cwd: process.cwd(),
          }
        );
        process.exit(EXIT_SUCCESS);
      }
    )

    // ── security <subcommand> ──────────────────────────────────────────────
    .command(
      "security [subcommand] [args..]",
      "View and act on Phase 4 security findings (SAST/DAST reports)",
      (y) =>
        y
          .positional("subcommand", {
            type: "string",
            choices: ["findings", "list", "report", "tools", "fix"] as const,
            default: "findings",
            describe: "Sub-command: findings | report | tools | fix",
          })
          .positional("args", { type: "string", array: true, describe: "Extra positional args" })
          .option("severity", { type: "string", describe: "Filter by severity (CRITICAL|HIGH|MEDIUM|LOW|INFO)" })
          .option("owasp", { type: "string", describe: "Filter by OWASP category" })
          .option("source", { type: "string", describe: "Filter by source scanner (zap|nikto|semgrep|…)" })
          .option("project", { type: "string", describe: "Project directory (default: cwd)" })
          .option("yes", { alias: "y", type: "boolean", describe: "Skip interactive prompts" }),
      async (args) => {
        await cmdSecurity(
          args.subcommand ?? "findings",
          (args.args ?? []) as string[],
          {
            severity: args.severity,
            owasp: args.owasp,
            source: args.source,
            project: args.project,
          }
        );
        process.exit(EXIT_SUCCESS);
      }
    )

    // ── trace <subcommand> ─────────────────────────────────────────────────
    .command(
      "trace [subcommand] [args..]",
      "View the cross-phase decision registry written by Pakalon agents",
      (y) =>
        y
          .positional("subcommand", {
            type: "string",
            choices: ["list", "show", "links", "summary", "search"] as const,
            default: "list",
            describe: "Sub-command: list | show | links | summary | search",
          })
          .positional("args", { type: "string", array: true, describe: "Extra positional args" })
          .option("type", { type: "string", describe: "Filter by decision type (requirement|security_finding|…)" })
          .option("phase", { type: "number", describe: "Filter by pipeline phase number" })
          .option("project", { type: "string", describe: "Project directory (default: cwd)" }),
      async (args) => {
        await cmdTrace(
          args.subcommand ?? "list",
          (args.args ?? []) as string[],
          {
            type: args.type,
            phase: args.phase,
            project: args.project,
          }
        );
        process.exit(EXIT_SUCCESS);
      }
    )

    .help()
    .alias("h", "help")
    .version()
    .alias("v", "version")
    .strict()
    .parseAsync();

  logger.debug("Parsed args", argv);
}

main()
  .then(() => shutdownTelemetry())
  .catch(async (err) => {
    await shutdownTelemetry();
    console.error(err);
    process.exit(99);
  });

