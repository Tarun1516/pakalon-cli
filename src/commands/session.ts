/**
 * Session management commands.
 */
import { getApiClient } from "@/api/client.js";
import { useStore } from "@/store/index.js";

export interface SessionSummary {
  id: string;
  title: string | null;
  mode: string;
  model_id: string | null;
  created_at: string;
  updated_at: string;
}

export async function cmdListSessions(limit = 10, cwd?: string): Promise<SessionSummary[]> {
  const client = getApiClient();
  const projectDir = cwd ?? process.cwd();
  const res = await client.get<{ sessions: SessionSummary[] }>("/sessions", {
    params: { limit, project_dir: projectDir },
  });
  return res.data.sessions ?? [];
}

export async function cmdCreateSession(title?: string, mode = "chat", cwd?: string): Promise<SessionSummary> {
  const client = getApiClient();
  const { selectedModel } = useStore.getState();
  const projectDir = cwd ?? process.cwd();
  const res = await client.post<SessionSummary>("/sessions", {
    title,
    mode,
    model_id: selectedModel,
    project_dir: projectDir,
  });
  useStore.getState().setSessionId(res.data.id);
  return res.data;
}

export async function cmdClearLocalSession(): Promise<void> {
  useStore.getState().clearSession();
}

/**
 * Resume a previous session by loading its messages from the backend.
 * If sessionId is omitted, the most recent session is used.
 */
export async function cmdResumeSession(sessionId?: string, cwd?: string): Promise<string | null> {
  const client = getApiClient();
  const projectDir = cwd ?? process.cwd();

  // Resolve target session id
  let targetId = sessionId;
  if (!targetId) {
    const res = await client.get<{ sessions: SessionSummary[] }>("/sessions", {
      params: { limit: 1, project_dir: projectDir },
    });
    const sessions = res.data.sessions ?? [];
    if (!sessions.length) return null;
    targetId = sessions[0]!.id;
  }

  // Load messages
  const msgsRes = await client.get<{ messages: Array<{ id: string; role: string; content: string; created_at: string }> }>(
    `/sessions/${targetId}/messages`
  );
  const msgs = msgsRes.data.messages ?? [];

  // Hydrate store
  const store = useStore.getState();
  store.clearSession();
  store.setSessionId(targetId);
  for (const m of msgs) {
    store.addMessage({
      id: m.id,
      role: m.role as "user" | "assistant" | "system",
      content: m.content,
      createdAt: new Date(m.created_at),
      isStreaming: false,
    });
  }

  return targetId;
}

/**
 * Fork the most recent session — creates a new session pre-populated with
 * all messages from the source session so conversations can diverge cleanly.
 */
export async function cmdForkSession(sourceSessionId?: string, cwd?: string): Promise<string | null> {
  const client = getApiClient();
  const projectDir = cwd ?? process.cwd();

  // Resolve source session
  let srcId = sourceSessionId ?? useStore.getState().sessionId ?? undefined;
  if (!srcId) {
    const res = await client.get<{ sessions: Array<SessionSummary> }>("/sessions", {
      params: { limit: 1, project_dir: projectDir },
    });
    const sessions = res.data.sessions ?? [];
    if (!sessions.length) return null;
    srcId = sessions[0]!.id;
  }

  // Load source messages
  const msgsRes = await client.get<{ messages: Array<{ id: string; role: string; content: string; created_at: string }> }>(
    `/sessions/${srcId}/messages`
  );
  const msgs = msgsRes.data.messages ?? [];

  // Create a new (forked) session
  const { selectedModel } = useStore.getState();
  const forkRes = await client.post<SessionSummary>("/sessions", {
    title: `Fork of ${srcId.slice(0, 8)}…`,
    mode: "chat",
    model_id: selectedModel,
    project_dir: projectDir,
  });
  const newId = forkRes.data.id;
  useStore.getState().setSessionId(newId);

  // Copy messages into the fork
  const store = useStore.getState();
  store.clearSession();
  store.setSessionId(newId);
  for (const m of msgs) {
    store.addMessage({
      id: m.id,
      role: m.role as "user" | "assistant" | "system",
      content: m.content,
      createdAt: new Date(m.created_at),
      isStreaming: false,
    });
    // Persist in backend too
    await client.post(`/sessions/${newId}/messages`, { role: m.role, content: m.content }).catch(() => {});
  }

  return newId;
}

/**
 * Replay stored user-only messages from the most recent session.
 * Useful for re-running a conversation with a different model / settings.
 */
export async function cmdReplayUserMessages(cwd?: string): Promise<string[]> {
  const client = getApiClient();
  const projectDir = cwd ?? process.cwd();

  const res = await client.get<{ sessions: Array<SessionSummary> }>("/sessions", {
    params: { limit: 1, project_dir: projectDir },
  });
  const sessions = res.data.sessions ?? [];
  if (!sessions.length) return [];

  const msgsRes = await client.get<{ messages: Array<{ role: string; content: string }> }>(
    `/sessions/${sessions[0]!.id}/messages`
  );
  return (msgsRes.data.messages ?? [])
    .filter((m) => m.role === "user")
    .map((m) => m.content);
}

/**
 * --continue flag: resume the most recent session from the backend.
 * Alias for cmdResumeSession() with no session ID argument.
 */
export async function cmdContinue(cwd?: string): Promise<string | null> {
  return cmdResumeSession(undefined, cwd);
}
