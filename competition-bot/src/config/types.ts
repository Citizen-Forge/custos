import { z } from 'zod';

// ── LLM Provider ──────────────────────────────────────────────────────

export const LlmProviderSchema = z.object({
  id: z.number().optional(),
  name: z.string().min(1),
  base_url: z.string().url(),
  api_key: z.string().default(''),
  model: z.string().min(1),
  rpm_limit: z.number().int().positive().default(10),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});
export type LlmProvider = z.infer<typeof LlmProviderSchema>;

// ── Competition Page ──────────────────────────────────────────────────

export const CompetitionPageSchema = z.object({
  id: z.number().optional(),
  name: z.string().min(1),
  url: z.string().url(),
  enabled: z.union([z.boolean(), z.number()]).default(true),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});
export type CompetitionPage = z.infer<typeof CompetitionPageSchema>;

// ── Exclusion Keyword ─────────────────────────────────────────────────

export const ExclusionKeywordSchema = z.object({
  id: z.number().optional(),
  keyword: z.string().min(1),
  created_at: z.string().optional(),
});
export type ExclusionKeyword = z.infer<typeof ExclusionKeywordSchema>;

// ── Competition (found) ───────────────────────────────────────────────

export const CompetitionStatus = z.enum([
  'found',
  'entered',
  'failed',
  'excluded',
  'skipped',
]);
export type CompetitionStatus = z.infer<typeof CompetitionStatus>;

export const CompetitionSchema = z.object({
  id: z.number().optional(),
  pageId: z.number(),
  title: z.string(),
  url: z.string(),
  sourcePageUrl: z.string(),
  description: z.string().default(''),
  requiresQuestions: z.boolean().default(false),
  status: CompetitionStatus.default('found'),
  exclusionReason: z.string().default(''),
  created_at: z.string().optional(),
});
export type Competition = z.infer<typeof CompetitionSchema>;

// ── Entry ─────────────────────────────────────────────────────────────

export const EntryStatus = z.enum(['success', 'failed']);
export type EntryStatus = z.infer<typeof EntryStatus>;

export const EntrySchema = z.object({
  id: z.number().optional(),
  competitionId: z.number(),
  competitionTitle: z.string().default(''),
  status: EntryStatus.default('success'),
  responseData: z.string().default(''),
  errorMessage: z.string().default(''),
  created_at: z.string().optional(),
});
export type Entry = z.infer<typeof EntrySchema>;

// ── Settings ──────────────────────────────────────────────────────────

export const SettingsSchema = z.object({
  scanIntervalMinutes: z.number().int().positive().default(60),
  headlessMode: z.boolean().default(true),
  maxConcurrentEntries: z.number().int().positive().default(3),
  defaultEmail: z.string().email().optional(),
  defaultName: z.string().optional(),
});
export type Settings = z.infer<typeof SettingsSchema>;

// ── API Response wrapper ──────────────────────────────────────────────

export interface ApiResponse<T> {
  ok: boolean;
  data?: T;
  error?: string;
}
