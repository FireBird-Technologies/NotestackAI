import { api, del, patch, post, put, qs, uploadFile } from "./client";
import type {
  Artifact,
  ArtifactType,
  CalendarItem,
  ChatMessage,
  ChatSummary,
  Doc,
  DocDetail,
  Job,
  Notebook,
  NotebookSummary,
  Page,
  Platform,
  ResurfaceItem,
  Settings,
  SocialAccounts,
  Source,
  TopicDetail,
  TopicMap,
  Usage,
  Voice,
  VoiceProfileData,
  VoiceState,
} from "./types";

type SourceJob = { source: Source; job: Job };

export const sourcesApi = {
  list: () => api<Source[]>("/api/sources"),
  connect: (url: string) => post<SourceJob>("/api/sources", { url }),
  importUrl: (url: string) => post<SourceJob>("/api/sources/url", { url }),
  importFile: async (file: File) => {
    const { upload_id } = await uploadFile(file);
    return post<SourceJob>("/api/sources/upload", { upload_id });
  },
  sync: (id: string) => post<SourceJob>(`/api/sources/${id}/sync`),
  remove: (id: string) => del<{ ok: true; removed_posts: number }>(`/api/sources/${id}`),
};

export const docsApi = {
  list: (p: { q?: string; source_id?: string; limit?: number; offset?: number } = {}) =>
    api<Page<Doc>>(`/api/documents${qs(p)}`),
  get: (id: string) => api<DocDetail>(`/api/documents/${id}`),
  remove: (id: string) => del(`/api/documents/${id}`),
};

export const notebooksApi = {
  list: () => api<NotebookSummary[]>("/api/notebooks"),
  get: (id: string) => api<Notebook>(`/api/notebooks/${id}`),
  create: (title: string, document_ids: string[] = [], description?: string) =>
    post<{ id: string; title: string; added: number }>("/api/notebooks", { title, document_ids, description }),
  fromTopic: (topicId: string) => post<{ id: string; title: string }>(`/api/notebooks/from-topic/${topicId}`),
  update: (id: string, body: { title?: string; description?: string }) => patch(`/api/notebooks/${id}`, body),
  remove: (id: string) => del(`/api/notebooks/${id}`),
  addDocs: (id: string, document_ids: string[]) =>
    post<{ added: number }>(`/api/notebooks/${id}/documents`, { document_ids }),
  removeDoc: (id: string, docId: string) => del(`/api/notebooks/${id}/documents/${docId}`),
  artifacts: (id: string) => api<Artifact[]>(`/api/notebooks/${id}/artifacts`),
  chats: (id: string) => api<ChatSummary[]>(`/api/notebooks/${id}/chats`),
  messages: (chatId: string) => api<ChatMessage[]>(`/api/notebooks/chats/${chatId}/messages`),
  removeChat: (chatId: string) => del(`/api/notebooks/chats/${chatId}`),
};

export type GenerateBody = {
  type: ArtifactType;
  notebook_id?: string;
  document_id?: string;
  format?: "deep_dive" | "brief" | "debate";
  minutes?: number;
  style?: "short" | "explainer" | "audiogram";
  audio_artifact_id?: string;
  slides?: { heading: string; body: string }[];
  parent_id?: string;
};

export const artifactsApi = {
  list: (p: { type?: string; notebook_id?: string; document_id?: string; status?: string; q?: string;
              limit?: number; offset?: number } = {}) => api<Page<Artifact>>(`/api/artifacts${qs(p)}`),
  get: (id: string) => api<Artifact>(`/api/artifacts/${id}`),
  generate: (body: GenerateBody) => post<Artifact>("/api/artifacts/generate", body),
  update: (id: string, body: { title?: string; content?: Record<string, unknown> }) =>
    patch<Artifact>(`/api/artifacts/${id}`, body),
  remove: (id: string) => del(`/api/artifacts/${id}`),
  retry: (id: string) => post<Artifact>(`/api/artifacts/${id}/retry`),
};

export const jobsApi = {
  active: () => api<Job[]>("/api/jobs?active=1"),
  recent: (kind?: string) => api<Job[]>(`/api/jobs${qs({ kind, limit: 10 })}`),
  get: (id: string) => api<Job>(`/api/jobs/${id}`),
};

export const topicsApi = {
  map: () => api<TopicMap>("/api/topics"),
  get: (id: string) => api<TopicDetail>(`/api/topics/${id}`),
  rebuild: (full = false) => post<Job>(`/api/topics/rebuild${qs({ full })}`),
};

export const voiceApi = {
  get: () => api<VoiceState>("/api/voice"),
  update: (body: { profile?: VoiceProfileData; host_voices?: { host_a: string; host_b: string } }) =>
    put<VoiceState>("/api/voice", body),
  build: (document_ids: string[]) => post<Job>("/api/voice/build", { document_ids }),
  voices: () => api<Voice[]>("/api/voice/voices"),
  consent: async (file: File, consent_text: string) => {
    const { upload_id } = await uploadFile(file);
    return post<VoiceState & { job: Job }>("/api/voice/consent", { upload_id, agreed: true, consent_text });
  },
  revoke: () => del<VoiceState>("/api/voice/consent"),
};

export type ItemBody = {
  platform: Platform;
  scheduled_at: string;
  content: string;
  thread?: string[];
  artifact_id?: string | null;
  document_id?: string | null;
  social_account_id?: string | null;
  remind_by_email?: boolean;
  draft?: boolean;
};

export const launchpadApi = {
  items: (p: { start?: string; end?: string; status?: string } = {}) => api<CalendarItem[]>(`/api/calendar${qs(p)}`),
  create: (body: ItemBody) => post<CalendarItem>("/api/calendar", body),
  update: (id: string, body: Partial<ItemBody> & { status?: "scheduled" | "draft" }) =>
    patch<CalendarItem>(`/api/calendar/${id}`, body),
  remove: (id: string) => del(`/api/calendar/${id}`),
  publishNow: (id: string) => post<CalendarItem>(`/api/calendar/${id}/publish`),
  accounts: () => api<SocialAccounts>("/api/social/accounts"),
  connectBluesky: (handle: string, app_password: string) =>
    post<SocialAccounts>("/api/social/bluesky", { handle, app_password }),
  startOAuth: (platform: "x" | "linkedin") => post<{ url: string }>(`/api/social/${platform}/start`),
  completeOAuth: (ticket: string) => post<SocialAccounts>("/api/social/complete", { ticket }),
  disconnect: (id: string) => del(`/api/social/accounts/${id}`),
};

export const resurfaceApi = {
  get: () => api<{ evergreen: ResurfaceItem[]; on_this_day: ResurfaceItem[]; unscored: number; total_posts: number }>(
    "/api/resurface",
  ),
  scan: () => post<Job>("/api/resurface/scan"),
};

export type SettingsPatch = {
  name?: string;
  workspace_name?: string;
  brand_name?: string;
  brand_accent?: string;
  logo_upload_id?: string;
  training_opt_in?: boolean;
  email_unsubscribed?: boolean;
};

export const settingsApi = {
  get: () => api<Settings>("/api/settings"),
  update: (body: SettingsPatch) => patch<Settings>("/api/settings", body),
  usage: () => api<Usage>("/api/settings/usage"),
};
