import { api, apiBlob, del, patch, post, postForm, put, qs, uploadFile } from "./client";
import type {
  AnswerFeedback,
  QuizAttempt,
  Artifact,
  ArtifactType,
  BillingStatus,
  CalendarItem,
  ChatMessage,
  ChatSummary,
  PublicInfographicData,
  PublicReportData,
  QuizQuestionType,
  ReportSuggestionKind,
  ReportTemplate,
  MemoryNote,
  Doc,
  DocDetail,
  Job,
  LibraryVoice,
  Notebook,
  NotebookSummary,
  WorkspaceChat,
  Page,
  Platform,
  PostableArtifact,
  Quota,
  ResurfaceItem,
  Settings,
  ShareInfo,
  SocialAccounts,
  Source,
  TopicDetail,
  TopicMap,
  Usage,
  Voice,
  Delivery,
  VoiceDesignInput,
  VoiceDesignPreview,
  VoiceProfileData,
  VoiceState,
  ExtractedTheme,
  LegacyVideo,
  MyTemplate,
  ScriptPreview,
  ScriptScene,
  TemplateGeneration,
  TemplatesResponse,
  VideoCatalog,
  VideoConfig,
  VideoCreateBody,
  VideoFocusSource,
  VideoFocusTopic,
  VideoJobState,
  VideoListItem,
  VideoOptions,
  VideoProject,
  VideoProjectData,
  VideoQuota,
  VideoSavedVoice,
  VideoScene,
  VideoStatus,
  VideoStyleItem,
  VideoVoicesResponse,
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
  list: (p: { q?: string; source_id?: string; indexed_only?: boolean; limit?: number; offset?: number } = {}) =>
    api<Page<Doc>>(`/api/documents${qs(p)}`),
  get: (id: string) => api<DocDetail>(`/api/documents/${id}`),
  remove: (id: string) => del(`/api/documents/${id}`),
};

export const notebooksApi = {
  list: () => api<NotebookSummary[]>("/api/notebooks"),
  get: (id: string) => api<Notebook>(`/api/notebooks/${id}`),
  create: (title: string, document_ids: string[] = [], description?: string) =>
    post<{ id: string; title: string; added: number }>("/api/notebooks", { title, document_ids, description }),
  /** The "All posts" notebook, created on first use. */
  archive: () => post<{ id: string; title: string }>("/api/notebooks/archive"),
  fromTopic: (topicId: string) => post<{ id: string; title: string }>(`/api/notebooks/from-topic/${topicId}`),
  update: (id: string, body: { title?: string; description?: string }) => patch(`/api/notebooks/${id}`, body),
  remove: (id: string) => del(`/api/notebooks/${id}`),
  addDocs: (id: string, document_ids: string[]) =>
    post<{ added: number }>(`/api/notebooks/${id}/documents`, { document_ids }),
  removeDoc: (id: string, docId: string) => del(`/api/notebooks/${id}/documents/${docId}`),
  artifacts: (id: string) => api<Artifact[]>(`/api/notebooks/${id}/artifacts`),
  chats: (id: string) => api<ChatSummary[]>(`/api/notebooks/${id}/chats`),
  /** Every answered chat in the workspace, newest first. */
  allChats: () => api<WorkspaceChat[]>("/api/notebooks/chats"),
  messages: (chatId: string) => api<ChatMessage[]>(`/api/notebooks/chats/${chatId}/messages`),
  removeChat: (chatId: string) => del(`/api/notebooks/chats/${chatId}`),
  /** Thumbs up or down on an answer. rating null takes it back. */
  rate: (messageId: string, body: { rating: "up" | "down" | null; reasons?: string[]; comment?: string }) =>
    put<{ feedback: AnswerFeedback | null }>(`/api/notebooks/messages/${messageId}/feedback`, body),
};

export type GenerateBody = {
  type: ArtifactType;
  notebook_id?: string;
  document_id?: string;
  /** No notebook or post: use the "All posts" notebook. */
  archive?: boolean;
  format?: "deep_dive" | "brief" | "critique" | "debate";
  /** audio_overview: a single narrator or a two host conversation. */
  hosts?: 1 | 2;
  minutes?: number;
  style?: "audiogram";
  audio_artifact_id?: string;
  /** audio_overview: the two hosts' voices, from the workspace's voices (none: the defaults). */
  host_a?: string;
  host_b?: string;
  slides?: { heading: string; body: string }[];
  parent_id?: string;
  /** mind_map: the posts to chart (none: all in the notebook) and what to centre on. */
  document_ids?: string[];
  focus?: string;
  /** quiz: made from a notebook's posts (notebook_id, document_ids) or from notebook chats (chat_ids). */
  chat_ids?: string[];
  topic?: string;
  count?: "fewer" | "standard" | "more";
  difficulty?: "easy" | "medium" | "hard";
  question_types?: QuizQuestionType[];
  language?: string;
  /** report: a written document or an interactive one, its template, and the instructions the writer is given. */
  report_format?: "document" | "interactive";
  template_id?: string;
  instructions?: string;
  /** infographic: one of the looks, and the kind of layout to lean towards (see components/Infographic.tsx); slide_deck: dark-space or light-space. */
  theme?: string;
  ig_style?: string;
  /** slide_deck: read on its own ("detailed") or shown behind a speaker ("presenter"), and how many slides. */
  deck_format?: "detailed" | "presenter";
  deck_length?: "short" | "default" | "long";
};

export const artifactsApi = {
  list: (p: { type?: string; notebook_id?: string; document_id?: string; status?: string; q?: string;
              limit?: number; offset?: number } = {}) => api<Page<Artifact>>(`/api/artifacts${qs(p)}`),
  get: (id: string) => api<Artifact>(`/api/artifacts/${id}`),
  generate: (body: GenerateBody) => post<Artifact>("/api/artifacts/generate", body),
  update: (id: string, body: { title?: string; content?: Record<string, unknown> }) =>
    patch<Artifact>(`/api/artifacts/${id}`, body),
  remove: (id: string) => del(`/api/artifacts/${id}`),
  /** An infographic drawn as a PNG. */
  image: (id: string, layout: "landscape" | "portrait" = "landscape") => apiBlob(`/api/artifacts/${id}/image${qs({ layout })}`),
  /** Thumbs up or down (null takes it back) on a finished report, quiz, flashcard set or infographic. */
  rate: (id: string, body: { rating: "up" | "down" | null; reasons?: string[]; comment?: string }) =>
    put<{ feedback: AnswerFeedback | null }>(`/api/artifacts/${id}/feedback`, body),
  /** A quiz's finished run, kept so the result shows when it is opened again. */
  saveAttempt: (id: string, body: { answers: QuizAttempt["answers"]; score: number }) =>
    put<{ attempt: QuizAttempt }>(`/api/artifacts/${id}/attempt`, body),
  retry: (id: string) => post<Artifact>(`/api/artifacts/${id}/retry`),
  /** A slide deck as a PDF (exactly as shown) or an editable PowerPoint. */
  slidesFile: (id: string, ext: "pdf" | "pptx") => apiBlob(`/api/artifacts/${id}/slides.${ext}`),
  /** A slide deck's slides as the editor has them, drawn without saving (after a slide or a text box is added,
   * removed, moved or changed to another layout). Returns them as they will be kept. */
  previewDeck: (id: string, slides: EditSlide[]) =>
    post<{ slides: EditSlide[]; slides_html: string[]; slide_slots: string[][] }>(`/api/artifacts/${id}/deck-preview`, { slides }),
  /** The editor's slides kept: the server fits the deck again and returns it. */
  saveDeck: (id: string, slides: EditSlide[]) => put<Artifact>(`/api/artifacts/${id}/deck`, { slides }),
};

/** One slide in the stored shape (backend app/slides/content.py, empty_slide). */
export type EditSlide = {
  layout: string;
  variant: string;
  kicker: string;
  heading: string;
  lead: string;
  points: { term: string; text: string }[];
  left: { label: string; items: string[] };
  right: { label: string; items: string[] };
  stat: { value: string; label: string };
  quote: { text: string; by: string };
  takeaways: string[];
  closing: string;
  notes: string;
  sources: { title?: string; path: string; line_start: number; line_end: number }[];
  shrink?: number;
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
  update: (body: {
    profile?: VoiceProfileData;
    host_voices?: Partial<{ host_a: string; host_b: string }>;
    delivery?: Partial<{ host_a: Delivery; host_b: Delivery }>;
  }) => put<VoiceState>("/api/voice", body),
  build: (document_ids: string[]) => post<Job>("/api/voice/build", { document_ids }),
  voices: () => api<Voice[]>("/api/voice/voices"),
  consent: async (files: File[], consent_text: string, remove_background_noise: boolean) => {
    const upload_ids = [];
    for (const f of files) upload_ids.push((await uploadFile(f)).upload_id);
    return post<VoiceState & { job: Job }>("/api/voice/consent", { upload_ids, agreed: true, consent_text, remove_background_noise });
  },
  library: (p: { search?: string; gender?: string; age?: string; accent?: string; language?: string; use_case?: string; page?: number }) =>
    api<{ voices: LibraryVoice[]; has_more: boolean }>(`/api/voice/library${qs(p)}`),
  addFromLibrary: (v: LibraryVoice, use_as?: "host_a" | "host_b") =>
    post<VoiceState & { voice_id: string }>("/api/voice/library/add", {
      public_owner_id: v.public_owner_id,
      voice_id: v.voice_id,
      name: v.name,
      use_as,
    }),
  preview: (voice_id: string, opts: { text?: string; host?: "host_a" | "host_b"; delivery?: Delivery } = {}) =>
    post<{ url: string; seconds: number }>("/api/voice/preview", { voice_id, ...opts }),
  readingScript: () => api<{ title: string; text: string; words: number }>("/api/voice/reading-script"),
  quota: () => api<Quota>("/api/voice/quota"),
  revoke: () => del<VoiceState>("/api/voice/consent"),
  design: (input: VoiceDesignInput) => post<{ description: string; previews: VoiceDesignPreview[] }>("/api/voice/design", input),
  saveDesign: (body: { generated_voice_id: string; name: string; description: string; use_as?: "host_a" | "host_b" }) =>
    post<VoiceState & { voice_id: string }>("/api/voice/design/save", body),
};

export type ItemBody = {
  platform: Platform;
  /** An exact instant (Post now). Scheduled posts send local_time + timezone instead. */
  scheduled_at?: string;
  /** The half hour picked on the user's own clock, "2026-10-07T11:00", read in `timezone` (IANA) by the backend. */
  local_time?: string;
  timezone?: string;
  content: string;
  thread?: string[];
  artifact_id?: string | null;
  /** The Launch Kit the post was written from (tracked, not attached). */
  kit_id?: string | null;
  document_id?: string | null;
  social_account_id?: string | null;
  remind_by_email?: boolean;
  draft?: boolean;
  /** Post now: published (or reminded) in the same request, never left scheduled. */
  publish_now?: boolean;
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
  /** What can be attached to a post (finished videos, quote cards, carousels, summaries, launch kits; not audio). */
  postable: (q = "") => api<PostableArtifact[]>(`/api/launchpad/postable${qs({ q: q || undefined })}`),
  /** A file from the user's computer, sent to storage: make it postable (an `upload` in the picker). */
  uploadToPost: async (file: File, duration_s?: number) => {
    const { upload_id } = await uploadFile(file);
    return post<PostableArtifact>("/api/launchpad/uploads", { upload_id, duration_s });
  },
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
  training_opt_in?: boolean;
  allow_public_links?: boolean;
  email_unsubscribed?: boolean;
};

export const settingsApi = {
  get: () => api<Settings>("/api/settings"),
  update: (body: SettingsPatch) => patch<Settings>("/api/settings", body),
  usage: () => api<Usage>("/api/settings/usage"),
  /** How many posts a generated thing can read (set by the server's ARTIFACT_MAX_POSTS settings). */
  limits: () => api<{ posts: number; selectable_posts: number }>("/api/settings/limits"),
};

export const memoryApi = {
  list: () => api<{ items: MemoryNote[]; limit: number }>("/api/memory"),
  put: (key: string, value: string) => put<MemoryNote>(`/api/memory/${encodeURIComponent(key)}`, { value }),
  remove: (key: string) => del(`/api/memory/${encodeURIComponent(key)}`),
};

export type BillingCycle = "monthly" | "annual";

export const billingApi = {
  status: () => api<BillingStatus>("/api/billing/status"),
  checkout: (plan: string, cycle: BillingCycle) => post<{ url: string }>("/api/billing/checkout", { plan, cycle }),
  portal: () => post<{ url: string }>("/api/billing/portal"),
  confirm: (sessionId: string) => post<BillingStatus>("/api/billing/confirm", { session_id: sessionId }),
};

function form(fields: Record<string, string | number | boolean | Blob | null | undefined>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    f.append(k, v instanceof Blob ? v : String(v));
  }
  return f;
}

export type ScriptDraft = { title: string; display_text: string; narration_text: string; revision: number;
                            draft_scenes: { id: number; title: string; display_text: string | null; narration_text: string }[] };

/** Videos are made by blog2video; the backend proxies every call. Ids here are our artifact ids. */
export const reportsApi = {
  templates: () => api<{ templates: ReportTemplate[]; interactive: ReportTemplate }>("/api/reports/templates"),
  /** Four AI-written templates for these sources (same source fields as a generate request, plus an optional topic). */
  suggest: (body: Record<string, unknown>) => post<{ templates: ReportTemplate[] }>("/api/reports/suggest", body),
  /** Add a visual after a section: made new, or copied from an artifact you already made. Runs as a job. */
  addBlock: (id: string, body: { kind: ReportSuggestionKind; after_block_id?: string; suggestion_id?: string; brief?: string;
                                 existing_artifact_id?: string; theme?: string }) => post<Artifact>(`/api/reports/${id}/blocks`, body),
  removeBlock: (id: string, blockId: string) => del<Artifact>(`/api/reports/${id}/blocks/${blockId}`),
};

export const shareApi = {
  get: (id: string) => api<ShareInfo>(`/api/artifacts/${id}/share`),
  create: (id: string) => post<ShareInfo>(`/api/artifacts/${id}/share`),
  update: (id: string, show_sources: boolean) => patch<ShareInfo>(`/api/artifacts/${id}/share`, { show_sources }),
  remove: (id: string) => del<ShareInfo>(`/api/artifacts/${id}/share`),
};

/** No sign in needed: what the public sees at a share link. */
export const publicApi = {
  report: (token: string) => api<PublicReportData | PublicInfographicData>(`/api/public/reports/${encodeURIComponent(token)}`),
};

export const videosApi = {
  config: () => api<VideoConfig>("/api/videos/config"),
  quota: () => api<VideoQuota>("/api/videos/quota"),
  catalog: () => api<VideoCatalog>("/api/videos/catalog"),
  list: () => api<VideoListItem[]>("/api/videos"),
  create: (body: VideoCreateBody) => post<Artifact>("/api/videos", body),
  /** Three topics the AI suggests a video from this source could focus on. */
  focusTopics: (body: VideoFocusSource) => post<{ topics: VideoFocusTopic[] }>("/api/videos/focus-topics", body),
  /** Multi-link: one video per link. Items with `error` say where it stopped (usually the allowance ran out). */
  createBatch: (urls: string[], options: VideoOptions) =>
    post<(Artifact | { error: string; url: string })[]>("/api/videos/batch", { ...options, urls }),
  /** Up to 5 documents; blog2video reads them itself. */
  createFromFiles: (files: File[], options: VideoOptions) => {
    const f = new FormData();
    files.forEach((file) => f.append("files", file));
    f.append("options", JSON.stringify(options));
    return postForm<Artifact>("/api/videos/upload", f);
  },
  get: (id: string) => api<VideoProject | LegacyVideo>(`/api/videos/${id}`),
  status: (id: string) => api<VideoStatus>(`/api/videos/${id}/status`),
  remove: (id: string) => del(`/api/videos/${id}`),
  // Script review
  script: (id: string) => api<{ status: string; scenes: ScriptScene[] }>(`/api/videos/${id}/script`),
  narrationPreview: (id: string, sceneId: number, body: ScriptDraft) =>
    post<ScriptPreview>(`/api/videos/${id}/script/scenes/${sceneId}/narration-preview`, body),
  approveScript: (id: string, scenes: (ScriptScene & { source_fingerprint?: string; accepted_ai_instructions?: string[] })[]) =>
    post<unknown>(`/api/videos/${id}/script/approve`, { scenes }),
};

const P = (id: string, path: string) => `/api/videos/${id}/p/${path}`;
export type LayoutSchema = Record<string, { defaults?: Record<string, unknown>; fields?: Record<string, unknown>[] }>;

/** The template's layouts, from blog2video's GET .../layouts. Variants ("news_headline__v2") are visual styles of a base
 * layout: layout_variants maps a base to its variant ids, layout_variant_labels names each ("Broadsheet"). */
export type LayoutInfo = {
  layouts: string[];
  layout_names?: Record<string, string>;
  layout_prop_schema?: LayoutSchema;
  layout_variants?: Record<string, string[]>;
  layout_variant_labels?: Record<string, string>;
};

export type StockClip = { provider: string; id: string; preview_url: string; thumbnail_url: string; download_url: string;
                          width: number; height: number; duration: number; author: string; page_url: string };

/** The editor: blog2video's project endpoints, through our allowlisted proxy. */
export const videoEditApi = {
  project: (id: string) => api<VideoProjectData>(P(id, "")),
  updateProject: (id: string, body: Partial<VideoProjectData>) => patch<VideoProjectData>(P(id, "update-project"), body),
  // Scenes
  updateScene: (id: string, sceneId: number, body: Partial<Pick<VideoScene, "title" | "display_text" | "narration_text" |
    "visual_description" | "duration_seconds" | "extra_hold_seconds" | "remotion_code">>) =>
    put<VideoScene>(P(id, `scenes/${sceneId}`), body),
  deleteScene: (id: string, sceneId: number) => del<unknown>(P(id, `scenes/${sceneId}`)),
  reorderScenes: (id: string, scene_orders: { scene_id: number; order: number }[]) =>
    post<VideoScene[]>(P(id, "scenes/reorder"), { scene_orders }),
  regenerateScene: (id: string, sceneId: number, body: { description?: string; narration_text?: string;
    regenerate_voiceover?: boolean; voiceover_verbatim?: boolean; layout?: string; image?: File }) =>
    postForm<VideoScene>(P(id, `scenes/${sceneId}/regenerate`), form(body)),
  addScene: (id: string, prompt: string, position?: number) => post<VideoJobState>(P(id, "scenes/add"), { prompt, position }),
  addSceneStatus: (id: string) => api<VideoJobState | null>(P(id, "scenes/add-status")),
  // Images
  uploadImage: (id: string, sceneId: number, image: File) => postForm<VideoScene>(P(id, `scenes/${sceneId}/image`), form({ image })),
  generateImage: (id: string, sceneId: number, image_description: string) =>
    // Not saved on the scene: the image comes back for the user to keep (uploadImage) or discard.
    post<{ image_base64: string; refined_prompt: string }>(P(id, `scenes/${sceneId}/generate-image`), { image_description }),
  imageFocus: (id: string, sceneId: number, body: { image_focus_x: number; image_focus_y: number; image_zoom?: number }) =>
    patch<VideoScene>(P(id, `scenes/${sceneId}/image-focus`), body),
  moveImage: (id: string, from_scene_id: number, to_scene_id: number) =>
    post<unknown>(P(id, "images/move"), { from_scene_id, to_scene_id }),
  swapImages: (id: string, first_scene_id: number, second_scene_id: number) =>
    post<unknown>(P(id, "images/swap"), { first_scene_id, second_scene_id }),
  duplicateImage: (id: string, source_scene_id: number, target_scene_id: number) =>
    post<unknown>(P(id, "images/duplicate"), { source_scene_id, target_scene_id }),
  /** Deletes the image or clip from the video for good (files too) and takes it off any scene. */
  /** The template's layouts; layout_prop_schema[layout].defaults holds its default font sizes (meta.json). */
  layouts: (id: string) => api<LayoutInfo>(P(id, "layouts")),
  deleteAsset: (id: string, assetId: number) => del<unknown>(P(id, `assets/${assetId}`)),
  assignImage: (id: string, scene_id: number, asset_id: number) =>
    post<unknown>(P(id, "images/assign-existing"), { scene_id, asset_id }),
  // Stock footage
  searchStock: (id: string, q: string) => api<{ clips: StockClip[] }>(P(id, `stock-footage/search${qs({ q })}`)),
  /** Downloads the clip into the project (a new asset). It is not on the scene until linkStock. */
  useStock: (id: string, sceneId: number, c: StockClip) =>
    post<{ asset_id: number; filename: string }>(P(id, `scenes/${sceneId}/stock-footage`), { provider: c.provider, clip_id: c.id,
      download_url: c.download_url, width: c.width, height: c.height, duration: c.duration, author: c.author,
      page_url: c.page_url }),
  /** Put a clip that is already in the project on a scene (assignedVideo). */
  linkStock: (id: string, scene_id: number, filename: string) =>
    post<unknown>(P(id, "stock-footage/link"), { scene_id, filename }),
  pendingStock: (id: string) => api<{ scenes?: unknown[]; [k: string]: unknown }>(P(id, "stock-footage/pending")),
  approveStock: (id: string) => post<unknown>(P(id, "stock-footage/approve")),
  rejectStock: (id: string) => post<unknown>(P(id, "stock-footage/reject")),
  // Voice, voiceovers, language, template
  uploadVoiceover: (id: string, sceneId: number, audio: File) =>
    postForm<VideoScene>(P(id, `scenes/${sceneId}/voiceover`), form({ audio })),
  deleteVoiceover: (id: string) => post<unknown>(P(id, "delete-voiceover")),
  changeVoice: (id: string, body: { voice_gender?: string; voice_accent?: string; custom_voice_id?: string | null }) => post<VideoJobState>(P(id, "change-voice"), body),
  voiceStatus: (id: string) => api<VideoJobState>(P(id, "voice-change-status")),
  changeLanguage: (id: string, content_language: string) => post<VideoJobState>(P(id, "change-language"), { content_language }),
  languageStatus: (id: string) => api<VideoJobState>(P(id, "language-change-status")),
  changeTemplate: (id: string, template: string) =>
    post<VideoJobState>(P(id, "change-template-regenerate-layouts"), { template }),
  templateStatus: (id: string) => api<VideoJobState>(P(id, "template-change-status")),
  // Refresh the script (keeps narration and voiceovers, rewrites titles and layouts)
  refreshScript: (id: string, user_instruction?: string) => post<VideoJobState>(P(id, "regenerate-script"), { user_instruction }),
  refreshStatus: (id: string) => api<VideoJobState>(P(id, "regenerate-script-status")),
  refreshPreview: (id: string) => api<Record<string, unknown>>(P(id, "regenerate-script/preview")),
  refreshVerify: (id: string) => post<unknown>(P(id, "regenerate-script/verify")),
  refreshRetry: (id: string, user_instruction?: string) =>
    post<VideoJobState>(P(id, "regenerate-script/regenerate"), { user_instruction }),
  // Render, download, frames
  /** force renders again even when an MP4 is already on R2 (blog2video otherwise just returns the old one). */
  render: (id: string, { force = false, resolution = "1080p" }: { force?: boolean; resolution?: string } = {}) =>
    post<VideoJobState>(P(id, `render${qs({ resolution, force_render: force || undefined })}`)),
  renderStatus: (id: string) => api<VideoJobState>(P(id, "render-status")),
  cancelRender: (id: string) => post<unknown>(P(id, "cancel-render")),
  downloadUrl: (id: string) => api<{ url: string }>(P(id, "download-url")),
  still: (id: string, frame: number) => apiBlob(P(id, `render-still${qs({ frame })}`)),
};

export const videoVoicesApi = {
  list: () => api<VideoVoicesResponse>("/api/video-voices"),
  save: (voice_id: string) => post<VideoSavedVoice>("/api/video-voices/saved", { voice_id }),
  unsave: (voice_id: string) => del(`/api/video-voices/saved/${encodeURIComponent(voice_id)}`),
};

export const videoStylesApi = {
  list: () => api<VideoStyleItem[]>("/api/video-styles"),
  aiDraft: (prompt: string) => post<{ name: string; guidance: string }>("/api/video-styles/ai-draft", { prompt }),
  create: (body: { name: string; guidance: string; creation_method: "manual" | "ai"; source_prompt?: string }) =>
    post<VideoStyleItem>("/api/video-styles", body),
  update: (styleId: number, body: { name: string; guidance: string; version: number }) =>
    patch<VideoStyleItem>(`/api/video-styles/${styleId}`, body),
  remove: (styleId: number) => del(`/api/video-styles/${styleId}`),
};

const T = (id: number, path: string) => `/api/video-templates/${id}/p/${path}`;

export const videoTemplatesApi = {
  list: () => api<TemplatesResponse>("/api/video-templates"),
  extractFromUrl: (url: string) => post<ExtractedTheme>("/api/video-templates/extract/url", { url }),
  extractFromPrompt: (prompt: string, name?: string) =>
    post<ExtractedTheme>("/api/video-templates/extract/prompt", { prompt, name }),
  extractFromDoc: (file: File, name: string) => postForm<ExtractedTheme>("/api/video-templates/extract/doc", form({ file, name })),
  create: (body: { name: string; theme: Record<string, unknown>; source_url?: string; logo_urls?: string[];
                   og_image?: string; screenshot_url?: string }) => post<MyTemplate>("/api/video-templates", body),
  generate: (id: number) => post<unknown>(`/api/video-templates/${id}/generate`),
  generationStatus: (id: number) => api<TemplateGeneration>(`/api/video-templates/${id}/generation-status`),
  remove: (id: number) => del(`/api/video-templates/${id}`),
  // Editing
  get: (id: number) => api<Record<string, unknown>>(T(id, "")),
  update: (id: number, body: { name?: string; theme?: Record<string, unknown> }) => put<Record<string, unknown>>(T(id, ""), body),
  uploadLogo: (id: number, file: File) => postForm<unknown>(T(id, "upload-logo"), form({ file })),
  drafts: (id: number) => api<unknown>(T(id, "scene-drafts")),
  applyDraft: (id: number, sceneKey: string) => post<unknown>(T(id, `scenes/${sceneKey}/draft/apply`)),
  discardDraft: (id: number, sceneKey: string) => post<unknown>(T(id, `scenes/${sceneKey}/draft/discard`)),
  fontDefaults: (id: number, body: Record<string, unknown>, sceneKey?: string) =>
    patch<unknown>(T(id, sceneKey ? `scenes/${sceneKey}/font-defaults` : "scenes/font-defaults"), body),
  chart: (id: number, sceneKey: string, body: Record<string, unknown>) => patch<unknown>(T(id, `scenes/${sceneKey}/chart`), body),
  versions: (id: number) => api<unknown>(T(id, "versions")),
  rollback: (id: number, versionId: number) => post<unknown>(T(id, `versions/${versionId}/rollback`)),
  regenerate: (id: number) => post<unknown>(T(id, "regenerate-code")),
  resume: (id: number) => post<unknown>(T(id, "resume-generation")),
  rate: (id: number, body: Record<string, unknown>) => post<unknown>(T(id, "rating"), body),
};
