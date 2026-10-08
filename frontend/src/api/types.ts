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
  /** Found but past the plan's post limit: listed, not indexed until the workspace upgrades. */
  locked_count: number;
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
  /** Found but past the plan's post limit: title and link only, not indexed until the workspace upgrades. */
  locked: boolean;
};

export type DocDetail = Doc & { lines: string[]; preview?: boolean; limit?: number };

export type Page<T> = { total: number; items: T[] };

export type NotebookSummary = {
  id: string;
  title: string;
  description: string | null;
  summary: string | null;
  document_count: number;
  chat_count: number;
  artifact_count: number;
  /** The always-present "All posts" notebook. */
  is_archive: boolean;
  updated_at: string | null;
};

export type Notebook = {
  id: string;
  title: string;
  description: string | null;
  summary: string | null;
  is_archive: boolean;
  documents: Doc[];
};

export type Citation = {
  marker: number;
  /** "post" (a line range of one of the writer's posts) or "chat" (what was said earlier in the notebook's chats). */
  kind?: "post" | "chat";
  document_id?: string | null;
  title: string;
  url: string;
  path: string;
  line_start: number;
  line_end: number;
  span: string;
};

export type ChatSummary = { id: string; title: string | null; updated_at: string | null };
export type AnswerFeedback = { rating: "up" | "down"; reasons: string[]; comment: string | null };
/** A chat listed across the whole workspace, with the notebook it belongs to. */
export type WorkspaceChat = ChatSummary & { notebook_id: string; notebook_title: string };
export type ChatMessage = { id: string; role: "user" | "assistant"; text: string; citations: Citation[]; feedback?: AnswerFeedback | null };

export type ArtifactType = "summary" | "audio_overview" | "video" | "quote_card" | "carousel" | "launch_kit" | "mind_map" | "quiz" | "flashcards" | "report" | "infographic" | "slide_deck" | "upload";

export type QuizQuestionType = "multiple_choice" | "multiple_select" | "fill_blank" | "short_answer";
export type QuizQuestion = {
  type: QuizQuestionType;
  question: string;
  options?: string[];
  /** Indexes into options (the choice types). */
  correct?: number[];
  /** fill_blank: the word for the blank. short_answer: a model answer. */
  answer?: string;
  accepted?: string[];
  explanation: string;
  sources: { document_id: string; title: string; line_start: number; line_end: number; quote: string }[];
};

export type FlashcardData = {
  front: string;
  back: string;
  sources: { document_id: string; title: string; line_start: number; line_end: number; quote: string }[];
};

/** One block of a report. Prose has Markdown whose [n] markers point into the report's citations. */
export type ReportBlock =
  | { id: string; type: "prose"; text: string }
  | { id: string; type: "callout"; title?: string; text: string }
  | { id: string; type: "key_terms"; title?: string; terms: { term: string; definition: string }[] }
  | { id: string; type: "table"; title?: string; headers: string[]; rows: string[][] }
  | { id: string; type: "timeline"; title?: string; events: { when: string; title: string; detail: string }[] }
  | { id: string; type: "mind_map"; title?: string; root: MindNode; node_count?: number; post_count?: number }
  | { id: string; type: "flashcards"; title?: string; cards: FlashcardData[] }
  | { id: string; type: "quiz"; title?: string; questions: QuizQuestion[] }
  /** An infographic (its own artifact, also in the Library): its page, once written (filled in when the report is read). */
  | { id: string; type: "infographic"; title?: string; artifact_id?: string; theme?: string; status?: string; html?: string | null; html_landscape?: string | null };

export type ReportSuggestionKind = "mind_map" | "flashcards" | "quiz" | "table" | "timeline" | "key_terms" | "infographic";
/** A spot where the AI thinks a visual would help: shown in the app with an Add button, never on a shared page. */
export type ReportSuggestion = { id: string; after_block_id: string; kind: ReportSuggestionKind; brief: string; why: string };

/** The link state of a report. */
export type ShareInfo = { shared: boolean; url: string | null; show_sources: boolean };

/** A report as the public sees it: no ids, quotes or paths. */
export type PublicReportData = {
  kind?: "report";
  title: string;
  format: "document" | "interactive";
  language: string;
  created_at: string | null;
  blocks: ReportBlock[];
  show_sources: boolean;
  sources?: { chats: number; posts: { title: string; url: string | null }[] };
};

/** An infographic as the public sees it: its title and the page (our own template output, shown in a sandboxed frame). */
export type PublicInfographicData = { kind: "infographic"; title: string; html: string; html_landscape?: string; created_at: string | null };

export type ReportTemplate = { id: string; name: string; description: string; prompt: string };

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
  status: "pending" | "generating" | "rendering" | "review" | "ready" | "failed" | "draft";
  notebook_id: string | null;
  document_id: string | null;
  content: Record<string, any>;
  storage_key: string | null;
  url: string | null;
  download_url: string | null;
  slide_urls: string[];
  created_at: string | null;
  job: Job | null;
  /** "blog2video" for videos made in the Videos editor. */
  provider?: string | null;
};

export type TopicStatus = "rising" | "steady" | "dormant";

export type TopicNode = {
  id: string;
  name: string;
  summary: string | null;
  post_count: number;
  first_at: string | null;
  last_at: string | null;
  recent_posts: number;
  momentum: number;
  status: TopicStatus;
  recency: number; // 0 = only written about at the start of the archive, 1 = written about most recently
  timeline: number[];
  galaxy: number;
};

export type Galaxy = { id: number; name: string; topic_ids: string[]; post_count: number; size: number };

export type TopicMap = {
  nodes: TopicNode[];
  edges: { source: string; target: string; weight: number }[];
  galaxies: Galaxy[];
  insights: {
    rising: { id: string; name: string; momentum: number }[];
    dormant: { id: string; name: string; last_at: string | null; post_count: number }[];
    pairs: { a: string; b: string; a_id: string; b_id: string; posts: number }[];
  };
  archive: { start: string | null; end: string | null; recent_from: string | null; posts: number };
  has_untagged_posts: boolean;
};

export type TopicDetail = {
  id: string;
  name: string;
  summary: string | null;
  post_count: number;
  first_at: string | null;
  last_at: string | null;
  recent_posts: number;
  momentum: number;
  status: TopicStatus;
  timeline: number[];
  timeline_start: string;
  timeline_end: string;
  related: { id: string; name: string; shared_posts: number }[];
  posts: (Doc & { weight: number })[];
};

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
  delivery: { host_a: Delivery; host_b: Delivery };
  model: string;
  models: Record<string, string>;
  clone: {
    allowed: boolean;
    consent_text: string;
    status: "none" | "processing" | "ready" | "failed";
    voice_id: string | null;
    created_at: string | null;
    error: string | null;
    preview_url: string | null;
  };
  /** Voices this workspace generated with Voice Design. */
  custom_voices: { voice_id: string; name: string; description?: string }[];
  tts_configured: boolean;
};

export type VoiceDesignInput = { prompt?: string; gender?: string; age?: string; persona?: string; pace?: string; accent?: string };
export type VoiceDesignPreview = { generated_voice_id: string; url: string; seconds: number | null };

export type Delivery = { stability: number; similarity_boost: number; style: number; speed: number; use_speaker_boost?: boolean };

export type Voice = {
  voice_id: string;
  name: string;
  category?: string | null;
  preview_url?: string | null;
  description?: string | null;
  labels?: Record<string, string>;
};

export type LibraryVoice = {
  public_owner_id: string;
  voice_id: string;
  name: string;
  description: string | null;
  preview_url: string | null;
  gender: string | null;
  age: string | null;
  accent: string | null;
  language: string | null;
  use_case: string | null;
  descriptive: string | null;
  category: string | null;
  cloned_by_count: number | null;
  free_users_allowed: boolean;
  notice_period: number | null;
};

export type Quota = {
  tier?: string;
  character_count?: number;
  character_limit?: number;
  can_use_instant_voice_cloning?: boolean;
  voice_slots_used?: number;
  voice_limit?: number;
};

export type Platform = "x" | "linkedin" | "bluesky" | "substack_notes";

/** Something made that a post can carry: images (quote card, carousel slides), a video, or text only. */
export type PostableArtifact = {
  id: string;
  type: ArtifactType;
  type_label: string;
  title: string;
  /** "audio": an audio overview, listed to download only (X and LinkedIn take no audio files). */
  media: "image" | "video" | "audio" | "text";
  media_count: number;
  duration_s: number | null;
  thumb_url: string | null;
  /** A video made but not rendered to an MP4 yet: it can be posted once rendered (in the video editor). */
  needs_render: boolean;
  /** Its MP4 is being rendered: it can be scheduled once that's done. */
  rendering: boolean;
  /** A Notestack (blog2video) video: it opens in the video editor. */
  editable_video: boolean;
  /** An uploaded file's link, to preview it (null for anything else). */
  view_url: string | null;
  /** An audio overview's file, saved as a download (null for anything else). */
  download_url?: string | null;
  /** Its posts still to go out (scheduled, ahead), soonest first: the Schedule a launch list offers to reschedule them. */
  scheduled?: { id: string; scheduled_at: string; platform_label: string }[];
  created_at: string | null;
  /** A starting text: X as a thread (list of posts), LinkedIn as one post. */
  prefill: { x: string[]; linkedin: string };
};

export type CalendarItem = {
  id: string;
  platform: Platform;
  platform_label: string;
  scheduled_at: string;
  /** paused: its account's connection is down (or held by hand); never attempted until resumed. */
  status: "scheduled" | "publishing" | "posted" | "reminded" | "failed" | "draft" | "paused";
  content: string;
  thread: string[];
  artifact_id: string | null;
  /** What the post carries (its images or video go out with it). */
  artifact: PostableArtifact | null;
  /** The Launch Kit the post was written from (tracked apart; never an attachment). */
  kit_id: string | null;
  kit_title: string | null;
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
  /** Down (expired, revoked, disconnected), or not allowed to post images and videos. */
  needs_reconnect: boolean;
  can_post_media: boolean;
  /** No refresh token and the connection ends within a week (LinkedIn's 60 day tokens). */
  expires_soon: boolean;
  expires_at: string | null;
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
  /** blog2video videos per period */
  videos: number;
  launch_kits: number;
  reports: number;
  infographics: number;
  voice_cloning: boolean;
  brand_kit: boolean;
};

export type Usage = {
  plan: string;
  used: { audio_minutes: number; videos: number; launch_kits: number; reports: number; infographics: number; llm_tokens: number; since: string };
  limits: { audio_minutes: number; videos: number; launch_kits: number; reports: number; infographics: number; sources: number; indexed_posts: number };
  videos_resets_at: string | null;
};

export type Settings = {
  user: { name: string | null; email: string; auth_provider: string; email_unsubscribed: boolean };
  workspace: { id: string; name: string; training_opt_in: boolean; allow_public_links: boolean };
  brand: { name: string | null; accent: string; logo_url: string | null };
  plan: Plan;
  billing_enabled: boolean;
  usage: Usage;
  integrations: { llm: boolean; elevenlabs: boolean; x: boolean; linkedin: boolean; storage: string; renderer: string };
};

export type MemoryNote = { key: string; value: string; source: "user" | "auto"; updated_at: string | null };

/** What the memory job changed after a chat message, shown under the answer. */
export type MemoryChange = { op: "add" | "update" | "delete"; key: string; value?: string };

export type PlanInfo = Plan & {
  tagline: string;
  price_monthly_usd: number;
  price_annual_monthly_usd: number;
  price_annual_usd: number;
  annual_savings_pct: number;
  features: string[];
};

export type Meter = { key: string; label: string; unit: string; used: number; limit: number; pct: number };

/** tone: limit (low or out of fuel), upgrade (locked perk), action (use what you have). No `to` opens the upgrade popup. */
export type Nudge = {
  id: string;
  tone: "limit" | "upgrade" | "action";
  title: string;
  body: string;
  cta: string;
  to: string | null;
  priority: number;
};

export type BillingStatus = {
  billing_enabled: boolean;
  plan: PlanInfo;
  plans: PlanInfo[];
  next_plan: string | null;
  can_upgrade: boolean;
  has_billing_account: boolean;
  period_end: string | null;
  meters: Meter[];
  since: string;
  /** Videos reset on renewal (or monthly without one), not on the 1st like the other meters. */
  videos_resets_at: string | null;
  nudges: Nudge[];
};

export type MindNode = {
  id: string;
  label: string;
  note: string;
  sources: { document_id: string; path: string; title: string; line_start: number; line_end: number; quote: string }[];
  children: MindNode[];
};

// Videos (blog2video). Everything goes through our API; ids are our artifact ids unless named b2v/custom.

export type VideoLimitMetric =
  | "ai_edits" | "templates" | "template_ai_daily" | "voice_designs_daily" | "voice_samples_daily" | "custom_voices";

export type VideoConfig = {
  configured: boolean;
  /** Premium (★) video options are included in this workspace's plan. */
  premium: boolean;
  limits: Record<VideoLimitMetric, { used: number; limit: number }>;
};

/** A row on the Videos page. */
export type VideoListItem = Artifact & {
  source_url: string | null;
  scenes: number | null;
  /** blog2video's own status: generated, done, awaiting_script_review, ... */
  b2v_status: string | null;
};

export type VideoQuota = { used: number; limit: number; plan: string; period_start: string | null; resets_at: string | null };

export type VideoTemplate = {
  id: string;
  name: string;
  description?: string;
  preview_url?: string | null;
  /** The 9:16 poster, for portrait videos. */
  preview_portrait_url?: string | null;
  genres?: string[];
  badge?: string | null;
  popular_template?: boolean;
  new_template?: boolean;
  preview_colors?: { accent?: string; bg?: string; text?: string };
  /** One of this workspace's own custom templates. */
  custom?: boolean;
};

export type VideoStyleItem = {
  /** "auto" | "explainer" | "storytelling" | "promotional" | "custom:<id>" */
  id: string;
  name: string;
  description?: string | null;
  /** house: made on our blog2video account and offered to everyone; the server sets the video length from it. */
  kind: "builtin" | "custom" | "house";
  custom_id?: number;
  guidance?: string | null;
  version?: number;
};

export type MusicTrack = { track_id: string; display_name: string; mood?: string; r2_url?: string | null };

export type VideoCatalog = {
  templates: VideoTemplate[];
  crafted_templates: VideoTemplate[];
  my_templates: VideoTemplate[];
  video_styles: VideoStyleItem[];
  music: MusicTrack[];
  languages: { code: string; name: string }[];
};

/** A voice in the workspace's "My voices" list (kept only in Notestack). */
export type VideoSavedVoice = {
  voice_id: string;
  name: string;
  preview_url: string | null;
  gender: string | null;
  accent: string | null;
  premium: boolean;
  is_custom: boolean;
  /** notestack: made or added on the Voice page (played through the Voice page's preview, not a link). */
  source?: "notestack" | "blog2video";
};

export type VideoLibraryVoice = {
  voice_id: string;
  name: string;
  description: string;
  preview_url: string | null;
  gender: string | null;
  accent: string | null;
  age?: string | null;
  premium: boolean;
  saved: boolean;
};

export type VideoCustomVoice = {
  id: number;
  voice_id: string;
  name: string;
  source: "prompt" | "preset" | "clone";
  preview_url: string | null;
  saved: boolean;
};

/** A voice the workspace made or added on the Voice page (its clone, a designed voice, a library voice). */
export type VideoNotestackVoice = { voice_id: string; name: string; kind: "clone" | "designed" | "library"; saved: boolean };

export type VideoVoicesResponse = {
  saved: VideoSavedVoice[];
  library: VideoLibraryVoice[];
  custom: VideoCustomVoice[];
  notestack: VideoNotestackVoice[];
};

export type VideoDesignedVoice = {
  generated_voice_id: string;
  audio_base_64: string;
  media_type: string;
  duration_secs: number;
};

export type VideoLength = "short" | "medium" | "detailed" | "more_detailed";
export type LogoPosition = "bottom_right" | "bottom_left" | "top_left" | "top_right";

/** Every field of the 3-step wizard, named as blog2video names them. */
export type VideoOptions = {
  // Step 1: Project
  stock_footage_enabled: boolean;
  aspect_ratio: "landscape" | "portrait";
  video_length: VideoLength;
  logo_upload_id?: string;
  logo_position: LogoPosition;
  logo_opacity: number;
  // Step 2: Template
  template: string;
  video_style: string;
  accent_color?: string;
  bg_color?: string;
  text_color?: string;
  // Step 3: Voice
  content_language?: string | null;
  voice_gender: "female" | "male" | "none";
  voice_accent: string;
  custom_voice_id?: string;
  voice_emotion?: string;
  bgm_track_id?: string;
  bgm_volume: number;
};

/** A workspace source the AI can suggest focus topics for. */
/** A focus topic the AI suggests: a short title, and two sentences on what the video would cover. */
export type VideoFocusTopic = { title: string; description: string };

export type VideoFocusSource = { document_id?: string; document_ids?: string[]; chat_ids?: string[]; notebook_id?: string };

export type VideoCreateBody = VideoOptions & {
  /** One of the suggested focus topics: the video is mainly about it. */
  focus?: string;
  /** The picked topic's description, sent so blog2video knows what to cover. */
  focus_detail?: string;
  /** Or the user's own focus topic, followed as far as the posts cover it (never with `focus`). */
  focus_prompt?: string;
  document_id?: string;
  /** A notebook's ticked posts, combined into one video. */
  document_ids?: string[];
  /** Names a combined video after its notebook. */
  notebook_id?: string;
  /** Notebook chats: their transcripts, after a prompt saying what they are (combined into one video). */
  chat_ids?: string[];
  url?: string;
  content?: string;
  title?: string;
};

export type VideoStatus = {
  video_id: number;
  status: string;
  step: number | null;
  running: boolean;
  ready: boolean;
  error: string | null;
  video_url: string | null;
  artifact_status: Artifact["status"];
  /** Made through the old partner integration: blog2video can no longer reach it, so only stored links remain. */
  legacy?: true;
};

export type VideoScene = {
  id: number;
  order: number;
  title: string;
  display_text: string | null;
  narration_text: string;
  visual_description?: string;
  preferred_layout?: string | null;
  duration_seconds: number;
  voiceover_path?: string | null;
  avatar_video_path?: string | null;
  bgm_volume?: number | null;
  extra_hold_seconds?: number | null;
  /** JSON: {"layout": ..., "layoutProps": {...}} (layoutConfig on custom templates). */
  remotion_code?: string | null;
  // Worked out by our backend (routers/videos.py _enrich)
  audio_url?: string | null;
  images?: { filename: string; asset_id: number | null; kind: string; url: string }[];
  layout?: string | null;
  title_font_size?: number | null;
  desc_font_size?: number | null;
  [key: string]: unknown;
};

export type VideoAsset = {
  id: number;
  asset_type: string;
  r2_url: string | null;
  filename: string;
  excluded: boolean;
  duration_seconds?: number | null;
  source_provider?: string | null;
};

/** blog2video's project, as its editor sees it. */
export type VideoProjectData = {
  id: number;
  name: string;
  status: string;
  template: string;
  aspect_ratio: "landscape" | "portrait";
  accent_color: string;
  bg_color: string;
  text_color: string;
  font_family: string | null;
  voice_gender: string;
  voice_accent: string;
  custom_voice_id: string | null;
  content_language: string | null;
  logo_r2_url: string | null;
  logo_position: string;
  logo_opacity: number;
  logo_size: number;
  bgm_track_id: string | null;
  bgm_volume: number;
  playback_speed: number;
  captions_enabled: boolean;
  caption_position: string;
  caption_font_family?: string | null;
  caption_font_size?: number | string | null;
  /** -100 (down) to 100 (up); 0 is the template's default place. */
  caption_offset?: number | null;
  r2_video_url: string | null;
  scenes: VideoScene[];
  assets: VideoAsset[];
  summary?: { scenes: number; images: number; clips?: number; duration_seconds: number };
  [key: string]: unknown;
};

/** A video made before the switch to our API key: stored links only, no edits. */
export type LegacyVideo = {
  legacy: true;
  status: string | null;
  ready: boolean;
  preview_url: string | null;
  video_url: string | null;
  artifact: Artifact;
};

export type VideoProject = {
  legacy?: undefined;
  video_id: number;
  status: string;
  preview_url: string | null;
  video_url: string | null;
  project: VideoProjectData;
  artifact: Artifact;
};

/** Background jobs (template, voice, language, add scene, render, script refresh) report progress in roughly this
 *  shape; each names things slightly differently. */
export type VideoJobState = { status?: string; running?: boolean; done?: boolean; error?: string | null;
                              progress?: number; video_url?: string | null; [key: string]: unknown };

export type ScriptScene = {
  id: number;
  order: number;
  title: string;
  display_text: string | null;
  narration_text: string;
  preferred_layout?: string | null;
};

export type ScriptPreview = { revision: number; title: string; display_text: string; narration_text: string;
                              source_fingerprint: string };

// Custom templates

export type MyTemplate = { id: number; ref: string; name: string; ready: boolean; created_at: string | null };

export type TemplatesResponse = {
  templates: MyTemplate[];
  limits: Record<"templates" | "template_ai_daily", { used: number; limit: number }>;
};

export type ExtractedTheme = {
  extractable: boolean;
  reason: string;
  theme: Record<string, unknown> | null;
  template_name: string;
  logo_urls: string[];
  og_image: string;
  screenshot_url: string;
};

export type TemplateGeneration = {
  status: string;
  step?: string | null;
  running: boolean;
  error: string | null;
  scenes_done?: number;
  scenes_total?: number;
  ready: boolean;
};
