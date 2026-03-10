import { getApiClient } from "@/api/client.js";

export interface AutomationTemplate {
  key: string;
  name: string;
  description: string;
  recommended_connectors: string[];
  default_cron: string;
  prompt_hint: string;
}

export interface AutomationRecord {
  id: string;
  name: string;
  description?: string | null;
  prompt: string;
  template_key?: string | null;
  inferred_config: Record<string, any>;
  required_connectors: string[];
  schedule_cron?: string | null;
  schedule_timezone: string;
  enabled: boolean;
  last_run_at?: string | null;
  last_status?: string | null;
  last_error?: string | null;
  created_at: string;
  updated_at: string;
  missing_connectors?: string[];
}

export interface ConnectorRecord {
  provider: string;
  display_name: string;
  category: string;
  oauth_supported: boolean;
  enabled: boolean;
  connected: boolean;
  connection_status: string;
  account_label?: string | null;
  scopes: string[];
  coming_soon: boolean;
}

export interface ConnectorCatalog {
  connected: ConnectorRecord[];
  available: ConnectorRecord[];
}

export interface AutomationLogRecord {
  id: string;
  automation_id: string;
  trigger_type: string;
  status: string;
  summary?: string | null;
  details: Record<string, any>;
  started_at: string;
  completed_at?: string | null;
}

export interface CronJobRecord {
  automation_id: string;
  automation_name: string;
  schedule_cron: string;
  schedule_timezone: string;
  enabled: boolean;
  next_run_at?: string | null;
  last_run_at?: string | null;
  last_status?: string | null;
}

export interface AutomationCreateInput {
  name: string;
  prompt: string;
  required_connectors?: string[];
  schedule_cron?: string;
  schedule_timezone?: string;
  template_key?: string;
}

export async function cmdListAutomations(): Promise<{ automations: AutomationRecord[]; templates: AutomationTemplate[] }> {
  const client = getApiClient();
  const response = await client.get<{ automations: AutomationRecord[]; templates: AutomationTemplate[] }>("/automations");
  return response.data;
}

export async function cmdCreateAutomation(input: AutomationCreateInput): Promise<AutomationRecord> {
  const client = getApiClient();
  const response = await client.post<AutomationRecord>("/automations", {
    name: input.name,
    prompt: input.prompt,
    required_connectors: input.required_connectors,
    schedule_cron: input.schedule_cron,
    schedule_timezone: input.schedule_timezone ?? "UTC",
    template_key: input.template_key,
  });
  return response.data;
}

export async function cmdUpdateAutomation(id: string, input: { enabled?: boolean; schedule_cron?: string; schedule_timezone?: string }): Promise<AutomationRecord> {
  const client = getApiClient();
  const response = await client.patch<AutomationRecord>(`/automations/${id}`, input);
  return response.data;
}

export async function cmdDeleteAutomation(id: string): Promise<{ queued: boolean; automation_id: string; message: string }> {
  const client = getApiClient();
  const response = await client.delete<{ queued: boolean; automation_id: string; message: string }>(`/automations/${id}`);
  return response.data;
}

export async function cmdRunAutomation(id: string): Promise<{ queued: boolean; automation_id: string; message: string }> {
  const client = getApiClient();
  const response = await client.post<{ queued: boolean; automation_id: string; message: string }>(`/automations/${id}/run`);
  return response.data;
}

export async function cmdListAutomationConnectors(): Promise<ConnectorCatalog> {
  const client = getApiClient();
  const response = await client.get<ConnectorCatalog>("/automations/connectors");
  return response.data;
}

export async function cmdStartAutomationOAuth(provider: string): Promise<{ provider: string; auth_url: string }> {
  const client = getApiClient();
  const response = await client.post<{ provider: string; auth_url: string }>(`/automations/connectors/${provider}/oauth/start`);
  return response.data;
}

export async function cmdToggleAutomationConnector(provider: string, enabled: boolean): Promise<ConnectorCatalog> {
  const client = getApiClient();
  const response = await client.post<ConnectorCatalog>(`/automations/connectors/${provider}/toggle`, { enabled });
  return response.data;
}

export async function cmdListAutomationCronJobs(): Promise<CronJobRecord[]> {
  const client = getApiClient();
  const response = await client.get<{ cron_jobs: CronJobRecord[] }>("/automations/cron-jobs");
  return response.data.cron_jobs;
}

export async function cmdListAutomationLogs(automationId?: string): Promise<AutomationLogRecord[]> {
  const client = getApiClient();
  const response = await client.get<{ logs: AutomationLogRecord[] }>("/automations/logs", {
    params: automationId ? { automation_id: automationId } : undefined,
  });
  return response.data.logs;
}

export function findAutomationByIdentifier(automations: AutomationRecord[], identifier: string): AutomationRecord | undefined {
  const normalized = identifier.trim().toLowerCase();
  return automations.find((item) => item.id === identifier || item.name.trim().toLowerCase() === normalized);
}