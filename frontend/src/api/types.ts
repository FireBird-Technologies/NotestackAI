export type JobStatus = "queued" | "running" | "done" | "failed";

export type Job = {
  id: string;
  kind: string;
  params: Record<string, unknown>;
  status: JobStatus;
  progress: number;
  message: string | null;
  error: string | null;
  result: Record<string, unknown>;
  artifact_id: string | null;
  attempts: number;
  created_at: string | null;
  finished_at: string | null;
};

export type Source = {
  id: string;
  feed_url: string;
  site_url: string | null;
  platform: string;
  title: string | null;
  sync_status: "pending" | "syncing" | "ok" | "error";
  sync_error: string | null;
  last_synced_at: string | null;
  document_count: number;
  is_imports: boolean;
};

export type Doc = {
  id: string;
  title: string;
  url: string;
  path: string | null;
  source_id: string | null;
  source_title: string | null;
  published_at: string | null;
  words: number;
  evergreen_score: number | null;
};

export type DocDetail = Doc & { lines: string[] };

export type Page<T> = { total: number; items: T[] };

export type NotebookSummary = {
  id: string;
  title: string;
  description: string | null;
  summary: string | null;
  document_count: number;
  chat_count: number;
  artifact_count: number;
  updated_at: string | null;
};

export type Notebook = {
  id: string;
  title: string;
  description: string | null;
  summary: string | null;
  documents: Doc[];
};

export type Citation = {
  marker: number;
  document_id?: string;
  title: string;
  url: string;
  path: string;
  line_start: number;
  line_end: number;
  span: string;
};

export type ChatSummary = { id: string; title: string | null; updated_at: string | null };
export type ChatMessage = { id: string; role: "user" | "assistant"; text: string; citations: Citation[] };

export type ArtifactType = "summary" | "audio_overview" | "video" | "quote_card" | "carousel" | "launch_kit";

export type SourceRef = { path: string; line_start: number; line_end: number; title?: string | null; quote?: string };

export type Segment = { speaker: string; text: string; start: number; end: number; sources: SourceRef[] };

export type LaunchKitContent = {
  title: string;
  post_title: string;
  post_url: string;
  claims: { claim: string; sources: SourceRef[] }[];
  hooks: { text: string; strength: number; rationale: string }[];
  posts: Record<"x_thread" | "linkedin" | "substack_notes" | "bluesky", string[]>;
  seo: {
    title_options?: string[];
    meta_description?: string;
    slug?: string;
    keywords?: string[];
    internal_links?: { path: string; anchor_text: string; reason: string }[];
  };
  carousel: { heading: string; body: string }[];
  quotes: { quote: string; source: SourceRef }[];
  quote_card_ids?: string[];
};

export type Artifact = {
  id: string;
  type: ArtifactType;
  type_label: string;
  title: string;
  status: "pending" | "generating" | "rendering" | "ready" | "failed" | "draft";
  notebook_id: string | null;
  document_id: string | null;
  content: Record<string, any>;
  storage_key: string | null;
  url: string | null;
  download_url: string | null;
  slide_urls: string[];
  created_at: string | null;
  job: Job | null;
};

export type TopicNode = { id: string; name: string; summary: string | null; post_count: number };
export type TopicMap = {
  nodes: TopicNode[];
  edges: { source: string; target: string; weight: number }[];
  has_untagged_posts: boolean;
};
export type TopicDetail = TopicNode & { posts: (Doc & { weight: number })[] };

export type VoiceProfileData = {
  tone: string[];
  sentence_length: "short" | "medium" | "long" | "varied";
  vocabulary: string[];
  structure_habits: string[];
  openings: string[];
  avoid: string[];
  summary: string;
};

export type VoiceState = {
  profile: VoiceProfileData | null;
  sample_doc_ids: string[];
  updated_at: string | null;
  host_voices: { host_a: string; host_b: string };
  clone: {
    allowed: boolean;
    consent_text: string;
    status: "none" | "processing" | "ready";
    voice_id: string | null;
    created_at: string | null;
  };
  tts_configured: boolean;
};

export type Voice = { voice_id: string; name: string; category?: string | null; preview_url?: string | null };

export type Platform = "x" | "linkedin" | "bluesky" | "substack_notes";

export type CalendarItem = {
  id: string;
  platform: Platform;
  platform_label: string;
  scheduled_at: string;
  status: "scheduled" | "publishing" | "posted" | "reminded" | "failed" | "draft";
  content: string;
  thread: string[];
  artifact_id: string | null;
  document_id: string | null;
  social_account_id: string | null;
  account_handle: string | null;
  remind_by_email: boolean;
  auto_post: boolean;
  external_url: string | null;
  posted_at: string | null;
  error: string | null;
  metrics: Record<string, number | string>;
  clicks: number;
};

export type SocialAccount = {
  id: string;
  platform: "x" | "linkedin" | "bluesky";
  platform_label: string;
  handle: string;
  status: string;
  avatar_url: string | null;
  connected_at: string | null;
};

export type SocialAccounts = {
  accounts: SocialAccount[];
  available: { x: boolean; linkedin: boolean; bluesky: boolean };
  redirect_uris: { x: string; linkedin: string };
};

export type ResurfaceItem = Doc & {
  reason: string | null;
  angle: string | null;
  last_resurfaced_at: string | null;
  rank?: number;
  years_ago?: number;
};

export type Plan = {
  id: string;
  name: string;
  sources: number;
  indexed_posts: number;
  audio_minutes: number;
  video_minutes: number;
  launch_kits: number;
  voice_cloning: boolean;
  brand_kit: boolean;
};

export type Usage = {
  plan: string;
  used: { audio_minutes: number; video_minutes: number; launch_kits: number; llm_tokens: number; since: string };
  limits: { audio_minutes: number; video_minutes: number; launch_kits: number; sources: number; indexed_posts: number };
};

export type Settings = {
  user: { name: string | null; email: string; auth_provider: string; email_unsubscribed: boolean };
  workspace: { id: string; name: string; training_opt_in: boolean };
  brand: { name: string | null; accent: string; logo_url: string | null };
  plan: Plan;
  billing_enabled: boolean;
  usage: Usage;
  integrations: { llm: boolean; elevenlabs: boolean; x: boolean; linkedin: boolean; storage: string; renderer: string };
};
