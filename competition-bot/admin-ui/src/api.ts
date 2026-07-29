const BASE = '/api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    ...options,
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || 'Request failed');
  return json.data as T;
}

// ── LLM Providers ─────────────────────────────────────────────────────

export interface LlmProvider {
  id: number;
  name: string;
  base_url: string;
  api_key: string;
  model: string;
  rpm_limit: number;
  created_at: string;
  updated_at: string;
}

export const providersApi = {
  list: () => request<LlmProvider[]>('/providers'),
  get: (id: number) => request<LlmProvider>(`/providers/${id}`),
  create: (data: Partial<LlmProvider>) =>
    request<LlmProvider>('/providers', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: number, data: Partial<LlmProvider>) =>
    request<LlmProvider>(`/providers/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  delete: (id: number) => request<void>(`/providers/${id}`, { method: 'DELETE' }),
  test: (data: { base_url: string; api_key: string; model: string }) =>
    request<{ success: boolean; message: string; model?: string }>('/providers/test', { method: 'POST', body: JSON.stringify(data) }),
};

// ── Competition Pages ────────────────────────────────────────────────

export interface CompetitionPage {
  id: number;
  name: string;
  url: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export const pagesApi = {
  list: () => request<CompetitionPage[]>('/pages'),
  get: (id: number) => request<CompetitionPage>(`/pages/${id}`),
  create: (data: Partial<CompetitionPage>) =>
    request<CompetitionPage>('/pages', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: number, data: Partial<CompetitionPage>) =>
    request<CompetitionPage>(`/pages/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  delete: (id: number) => request<void>(`/pages/${id}`, { method: 'DELETE' }),
};

// ── Competitions ─────────────────────────────────────────────────────

export interface Competition {
  id: number;
  page_id: number;
  title: string;
  url: string;
  source_page_url: string;
  description: string;
  requires_questions: number;
  status: string;
  exclusion_reason: string;
  created_at: string;
}

export const competitionsApi = {
  list: (status?: string) =>
    request<Competition[]>(`/competitions${status ? `?status=${status}` : ''}`),
  get: (id: number) => request<Competition>(`/competitions/${id}`),
  delete: (id: number) => request<void>(`/competitions/${id}`, { method: 'DELETE' }),
  deleteAll: (status?: string) =>
    request<void>(`/competitions${status ? `?status=${status}` : ''}`, { method: 'DELETE' }),
  reset: (id: number) => request<Competition>(`/competitions/${id}/reset`, { method: 'POST' }),
};

// ── Entries ──────────────────────────────────────────────────────────

export interface Entry {
  id: number;
  competition_id: number;
  competition_title: string;
  status: string;
  response_data: string;
  error_message: string;
  screenshot_before: string;
  screenshot_after: string;
  created_at: string;
}

export const entriesApi = {
  list: (limit?: number) =>
    request<Entry[]>(`/entries${limit ? `?limit=${limit}` : ''}`),
  get: (id: number) => request<Entry>(`/entries/${id}`),
};

// ── Exclusion Keywords ───────────────────────────────────────────────

export interface ExclusionKeyword {
  id: number;
  keyword: string;
  created_at: string;
}

export const keywordsApi = {
  list: () => request<ExclusionKeyword[]>('/keywords'),
  create: (keyword: string) =>
    request<ExclusionKeyword>('/keywords', { method: 'POST', body: JSON.stringify({ keyword }) }),
  delete: (id: number) => request<void>(`/keywords/${id}`, { method: 'DELETE' }),
};

// ── Settings ─────────────────────────────────────────────────────────

export interface Settings {
  scan_interval_minutes: string;
  headless_mode: string;
  max_concurrent_entries: string;
  default_email: string;
  default_name: string;
  llm_verification_enabled: string;
  verification_provider_id: string;
  entry_interval_seconds: string;
  captcha_service: string;
  captcha_api_key: string;
}

export const settingsApi = {
  get: () => request<Settings>('/settings'),
  update: (data: Partial<Settings>) =>
    request<Settings>('/settings', { method: 'PUT', body: JSON.stringify(data) }),
};

// ── Scan & Enter ─────────────────────────────────────────────────────

export const scanApi = {
  page: (pageId: number) => request<{ found: number }>(`/scan/${pageId}`, { method: 'POST' }),
  all: () => request<Array<{ pageId: number; pageName: string; found: number }>>('/scan/all', { method: 'POST' }),
};

export const enterApi = {
  competition: (competitionId: number, providerId: number) =>
    request<{ success: boolean; message: string }>(`/enter/${competitionId}`, {
      method: 'POST',
      body: JSON.stringify({ providerId }),
    }),
  batch: (providerId: number) =>
    request<Array<{ competitionId: number; success: boolean; message: string }>>(`/enter/batch/${providerId}`, { method: 'POST' }),
};

// ── Profile Fields ──────────────────────────────────────────────────

export interface ProfileField {
  id: number;
  field_key: string;
  field_label: string;
  field_value: string;
  created_at: string;
  updated_at: string;
}

export const profileFieldsApi = {
  list: () => request<ProfileField[]>('/profile-fields'),
  create: (data: { field_key: string; field_label: string; field_value?: string }) =>
    request<ProfileField>('/profile-fields', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: number, data: { field_key?: string; field_label?: string; field_value?: string }) =>
    request<ProfileField>(`/profile-fields/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  delete: (id: number) => request<void>(`/profile-fields/${id}`, { method: 'DELETE' }),
};

// ── Stats ────────────────────────────────────────────────────────────

export interface Stats {
  total: number;
  entered: number;
  pending: number;
  failed: number;
  excluded: number;
  providers: number;
  pages: number;
}

export const statsApi = {
  get: () => request<Stats>('/stats'),
};

// ── Browser Test ────────────────────────────────────────────────────

export interface FingerprintSignal {
  value: string;
  status: 'pass' | 'warn' | 'fail';
  tip?: string;
}

export interface RealPageTest {
  attempted: boolean;
  url: string;
  status: number;
  error: string;
  bodyLength: number;
}

export interface BrowserTestResult {
  browser: string;
  headless: boolean;
  score: number;
  grade: string;
  summary: string;
  signals: Record<string, FingerprintSignal>;
  userAgent: string;
  realPageTest?: RealPageTest;
}

// ── VPN ────────────────────────────────────────────────────────────

export interface VpnConfig {
  id: number;
  label: string;
  filename: string;
  country: string;
  created_at: string;
}

export interface VpnStatus {
  available: boolean;
  connected: boolean;
  configId: number | null;
  configLabel: string | null;
  serverIp: string | null;
  configCount: number;
}

export const vpnApi = {
  status: () => request<VpnStatus>('/vpn/status'),
  configs: () => request<VpnConfig[]>('/vpn/configs'),
  getConfig: (id: number) => request<VpnConfig>(`/vpn/configs/${id}`),
  addConfig: (label: string, content: string) =>
    request<VpnConfig>('/vpn/configs', { method: 'POST', body: JSON.stringify({ label, content }) }),
  deleteConfig: (id: number) => request<void>(`/vpn/configs/${id}`, { method: 'DELETE' }),
  connect: (configId: number) =>
    request<{ success: boolean; status: VpnStatus }>(`/vpn/connect/${configId}`, { method: 'POST' }),
  connectRandom: () =>
    request<{ success: boolean; status: VpnStatus }>('/vpn/connect-random', { method: 'POST' }),
  rotate: () =>
    request<{ success: boolean; status: VpnStatus }>('/vpn/rotate', { method: 'POST' }),
  disconnect: () =>
    request<{ status: VpnStatus }>('/vpn/disconnect', { method: 'POST' }),
};

export const testBrowserApi = {
  run: () => request<BrowserTestResult>('/test-browser', { method: 'POST' }),
};
