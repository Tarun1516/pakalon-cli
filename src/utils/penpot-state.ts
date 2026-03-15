import fs from "node:fs";
import path from "node:path";

export interface PenpotProjectState {
  version: number;
  baseUrl: string;
  fileId: string | null;
  projectId: string | null;
  projectUrl: string | null;
  fileUrl: string | null;
  revision: number | null;
  phase: number | null;
  status: string | null;
  source: string | null;
  updatedAt: string | null;
  localSvgPath: string | null;
  localJsonPath: string | null;
  projectDir: string;
  sourceFile?: string;
}

function defaultBaseUrl(): string {
  return (process.env.PENPOT_BASE_URL ?? process.env.PENPOT_HOST ?? "http://localhost:3449").replace(/\/$/, "");
}

function readJson(filePath: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function pick(raw: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = raw[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function extractIdsFromUrl(url?: string | null): { projectId: string | null; fileId: string | null } {
  if (!url) return { projectId: null, fileId: null };
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts[0] === "view" && parts.length >= 3) {
      return { projectId: parts[1] ?? null, fileId: parts[2] ?? null };
    }
    if (parts[0] === "view" && parts.length >= 2) {
      return { projectId: null, fileId: parts[1] ?? null };
    }
  } catch {
    return { projectId: null, fileId: null };
  }
  return { projectId: null, fileId: null };
}

function buildUrls(baseUrl: string, fileId: string | null, projectId: string | null, projectUrl?: string | null, fileUrl?: string | null) {
  let nextProjectUrl = projectUrl ?? null;
  let nextFileUrl = fileUrl ?? null;
  if (!nextProjectUrl && fileId && projectId) {
    nextProjectUrl = `${baseUrl}/view/${projectId}/${fileId}`;
  }
  if (!nextFileUrl && fileId) {
    nextFileUrl = nextProjectUrl ?? `${baseUrl}/view/${fileId}`;
  }
  return { projectUrl: nextProjectUrl, fileUrl: nextFileUrl };
}

export function normalizePenpotProjectState(raw: Record<string, unknown>, projectDir: string, sourceFile?: string): PenpotProjectState {
  const baseUrl = String(pick(raw, "base_url", "baseUrl", "penpot_base_url") ?? defaultBaseUrl()).replace(/\/$/, "");
  const rawProjectUrl = pick(raw, "project_url", "projectUrl", "penpot_project_url");
  const rawFileUrl = pick(raw, "file_url", "fileUrl", "penpot_file_url");
  const idsFromUrl = extractIdsFromUrl(typeof rawProjectUrl === "string" ? rawProjectUrl : undefined);

  const projectIdValue = pick(raw, "project_id", "projectId", "penpot_project_id") ?? idsFromUrl.projectId;
  const fileIdValue = pick(raw, "file_id", "fileId", "penpot_file_id") ?? idsFromUrl.fileId;

  const projectId = projectIdValue ? String(projectIdValue) : null;
  const fileId = fileIdValue ? String(fileIdValue) : null;
  const { projectUrl, fileUrl } = buildUrls(
    baseUrl,
    fileId,
    projectId,
    typeof rawProjectUrl === "string" ? rawProjectUrl : null,
    typeof rawFileUrl === "string" ? rawFileUrl : null,
  );

  const revisionValue = pick(raw, "revision", "revn", "penpot_revn");
  const phaseValue = pick(raw, "phase", "source_phase");

  return {
    version: Number(pick(raw, "version") ?? 1),
    baseUrl,
    fileId,
    projectId,
    projectUrl,
    fileUrl,
    revision: revisionValue === undefined ? null : Number(revisionValue),
    phase: phaseValue === undefined ? null : Number(phaseValue),
    status: (pick(raw, "status") as string | undefined) ?? null,
    source: (pick(raw, "source") as string | undefined) ?? null,
    updatedAt: (pick(raw, "updated_at", "updatedAt") as string | undefined) ?? null,
    localSvgPath: (pick(raw, "local_svg_path", "localSvgPath", "wireframe_svg_path") as string | undefined) ?? null,
    localJsonPath: (pick(raw, "local_json_path", "localJsonPath", "wireframe_json_path") as string | undefined) ?? null,
    projectDir,
    sourceFile,
  };
}

export function getPenpotStatePath(projectDir: string): string {
  return path.join(projectDir, ".pakalon", "penpot.json");
}

export function resolvePenpotProjectState(projectDir: string): PenpotProjectState | null {
  const candidates = [
    getPenpotStatePath(projectDir),
    path.join(projectDir, ".pakalon-agents", "ai-agents", "phase-2", "phase-2-manifest.json"),
    path.join(projectDir, ".pakalon-agents", "ai-agents", "phase-2", "url-manifest.json"),
    path.join(projectDir, ".pakalon-agents", "ai-agents", "phase-2", "penpot_meta.json"),
  ];

  for (const candidate of candidates) {
    const raw = readJson(candidate);
    if (raw) {
      return normalizePenpotProjectState(raw, projectDir, candidate);
    }
  }

  return null;
}