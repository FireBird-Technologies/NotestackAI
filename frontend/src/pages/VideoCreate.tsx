import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { videosApi, videoVoicesApi } from "../api/endpoints";
import type {
  VideoCatalog,
  VideoConfig,
  VideoFocusSource,
  VideoFocusTopic,
  VideoOptions,
  VideoQuota,
  VideoSavedVoice,
  VideoStyleItem,
  VideoTemplate,
  VideoVoicesResponse,
} from "../api/types";
import { Dropdown } from "../components/Dropdown";
import { CheckIcon, SparkleIcon } from "../components/icons/Icons";
import { errorMessage, Loading, PageHeader } from "../components/ui";
import { SourcePicker, type VideoSource } from "../components/video/SourcePicker";
import { loadArchiveId, sourceCache } from "../components/video/sourceCache";
import { PhoneIcon, PlayButton, ScreenIcon, TemplateThumb, useAudio } from "../components/video/parts";
import { useUpgrade } from "../hooks/useUpgrade";

const FORMATS = [
  { id: "landscape", name: "Landscape", label: "Landscape (16:9), for YouTube", Icon: ScreenIcon },
  { id: "portrait", name: "Portrait", label: "Portrait (9:16), for TikTok and Reels", Icon: PhoneIcon },
] as const;

const FALLBACK_COLORS = { accent_color: "#7c3aed", bg_color: "#ffffff", text_color: "#000000" };

/** A template and the colours it was designed with. */
const templateFields = (t: VideoTemplate) => ({
  template: t.id,
  accent_color: t.preview_colors?.accent ?? FALLBACK_COLORS.accent_color,
  bg_color: t.preview_colors?.bg ?? FALLBACK_COLORS.bg_color,
  text_color: t.preview_colors?.text ?? FALLBACK_COLORS.text_color,
});

const cap = (s?: string | null) => (s ? s[0].toUpperCase() + s.slice(1) : "");

function Steps({ step }: { step: number }) {
  const names = ["Project", "Template", "Voice"];
  return (
    <div className="vw-steps" aria-label={`Step ${step} of 3: ${names[step - 1]}`}>
      <ol>
        {names.map((name, i) => (
          <li key={i} className={i + 1 < step ? "done" : i + 1 === step ? "on" : ""} title={name}
              aria-current={i + 1 === step ? "step" : undefined}>
            <span>{i + 1 < step ? <CheckIcon size={14} /> : i + 1}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** The New video page (/app/videos/new?notebook_id=… | document_id=…). */
export default function VideoCreate() {
  const [params] = useSearchParams();
  return <VideoCreateForm startNotebook={params.get("notebook_id")} startDoc={params.get("document_id")} />;
}

/** The three-step video wizard: as a page, or inside a modal (inModal: no page header, no step-1 Back, no outer card;
 * the modal's own close button leaves it). */
export function VideoCreateForm({ startNotebook = null, startDoc = null, inModal = false }: {
  startNotebook?: string | null; startDoc?: string | null; inModal?: boolean;
}) {
  const navigate = useNavigate();
  const { openUpgrade } = useUpgrade();

  const [config, setConfig] = useState<VideoConfig | null>(null);
  const [catalog, setCatalog] = useState<VideoCatalog | null>(null);
  const [voices, setVoices] = useState<VideoVoicesResponse | null>(null);
  const [quota, setQuota] = useState<VideoQuota | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [step, setStep] = useState(1);
  const [source, setSource] = useState<VideoSource | null>(
    startNotebook ? { kind: "notebook", id: startNotebook } : startDoc ? { kind: "post", id: startDoc }
      : sourceCache.archiveId ? { kind: "notebook", id: sourceCache.archiveId } : null,
  );
  const [postIds, setPostIds] = useState<string[]>([]);
  const [chatIds, setChatIds] = useState<string[]>([]);
  // Step 2's "focus on": the AI's three suggestions for the step 1 choice (sourceKey), and the one picked (none =
  // the whole material).
  const [topics, setTopics] = useState<VideoFocusTopic[] | null>(null);
  const topicsFor = useRef(""); // the sourceKey of the suggestions shown or on their way
  const [focus, setFocus] = useState<VideoFocusTopic | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { playing, play } = useAudio();

  const [form, setForm] = useState<VideoOptions>({
    stock_footage_enabled: true,
    aspect_ratio: "landscape",
    video_length: "medium", // no length picker: the server sets it from a house style
    logo_position: "bottom_right",
    logo_opacity: 0.9,
    template: "default",
    video_style: "auto",
    ...FALLBACK_COLORS,
    content_language: null,
    voice_gender: "female",
    voice_accent: "american",
    bgm_volume: 0.1,
  });
  const set = (patch: Partial<VideoOptions>) => setForm((f) => ({ ...f, ...patch }));
  const gridBox = useRef<HTMLDivElement>(null);

  const premium = !!config?.premium;

  const loadVoices = useCallback(
    () => videoVoicesApi.list().then((v) => {
      setVoices(v);
      return v;
    }),
    [],
  );

  useEffect(() => {
    videosApi.config().then(setConfig).catch((e) => setLoadError(errorMessage(e)));
    videosApi.quota().then(setQuota).catch(() => undefined);
    // Nothing picked on the way in: start from every post, in the "All posts" notebook.
    if (!startNotebook && !startDoc && !sourceCache.archiveId) {
      loadArchiveId().then((id) => setSource((s) => s ?? { kind: "notebook", id })).catch(() => undefined);
    }
  }, [startNotebook, startDoc]);

  useEffect(() => {
    if (!config?.configured) return;
    videosApi.catalog().then((c) => {
      setCatalog(c);
      // Start on a random built-in template (never a premium designer one), unless the form already names a real one.
      const pool = c.templates.filter((t) => !t.id.startsWith("crafted_"));
      const first = pool[Math.floor(Math.random() * pool.length)];
      const known = new Set([...c.my_templates, ...c.crafted_templates, ...c.templates].map((t) => t.id));
      if (first) setForm((f) => (known.has(f.template) ? f : { ...f, ...templateFields(first) }));
      // Start on the first house style (Overview) unless the form already names one on offer.
      const house = c.video_styles.filter((s) => s.kind === "house");
      if (house.length) setForm((f) => (house.some((s) => s.id === f.video_style) ? f : { ...f, video_style: house[0].id }));
    }).catch((e) => setLoadError(errorMessage(e)));
    loadVoices()
      .then((v) => v.saved[0] && pickVoice(v.saved[0]))
      .catch(() => setVoices({ saved: [], library: [], custom: [] }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config?.configured]);

  // Keep the chosen template visible inside the template grid's own scroll box (never scrolls the page).
  useEffect(() => {
    const box = gridBox.current;
    const card = box?.querySelector<HTMLElement>(`[data-id="${CSS.escape(form.template)}"]`);
    if (!box || !card) return;
    const top = card.offsetTop; // the box is position: relative, so this is measured from its top
    if (top < box.scrollTop || top + card.offsetHeight > box.scrollTop + box.clientHeight) {
      box.scrollTop = top - 8;
    }
  }, [form.template, step, catalog]);

  const templates = catalog?.templates ?? [];
  const shown: VideoTemplate[] = templates;
  // The house styles alone when the account has them; otherwise "Auto" and the rest, as before.
  const listed = catalog?.video_styles ?? [];
  const houseStyles = listed.some((s) => s.kind === "house");
  const styles: VideoStyleItem[] = houseStyles ? listed : [{ id: "auto", name: "Auto", kind: "builtin" }, ...listed];
  const picked = styles.find((s) => s.id === form.video_style);
  const saved = voices?.saved ?? [];
  const left = quota ? Math.max(quota.limit - quota.used, 0) : null;

  function pickTemplate(t: VideoTemplate) {
    if (t.id.startsWith("crafted_") && !premium) return openUpgrade();
    set(templateFields(t));
  }

  function pickVoice(v: VideoSavedVoice) {
    if (v.premium && config && !config.premium) return openUpgrade();
    setForm((f) => ({
      ...f,
      voice_gender: v.gender === "male" ? "male" : "female",
      voice_accent: v.accent === "british" ? "british" : "american",
      custom_voice_id: v.voice_id,
    }));
  }

  const sourceReady = source?.kind === "post" || (source?.kind === "chats" && chatIds.length > 0)
    || (source?.kind === "notebook" && postIds.length > 0);

  /** Step 1's choice as API fields: the same for the focus suggestions and the create. */
  const sourceFields = (): VideoFocusSource | null => !source ? null
    : source.kind === "post" ? { document_id: source.id }
    : source.kind === "chats" ? { chat_ids: chatIds }
    : { document_ids: postIds, notebook_id: source.id };
  // The focus suggestions belong to one step 1 choice. They are asked for while still on step 1, as soon as the choice
  // is complete, so they are usually there by step 2; a new source or other ticks asks again. The short wait lets a
  // run of ticks settle into one request.
  const sourceKey = !source ? ""
    : source.kind === "chats" ? `chats:${[...chatIds].sort().join(",")}`
    : `${source.kind}:${source.id}:${source.kind === "notebook" ? [...postIds].sort().join(",") : ""}`;

  useEffect(() => {
    if (!sourceReady || sourceKey === topicsFor.current) return;
    const fields = sourceFields();
    if (!fields) return;
    const timer = setTimeout(() => {
      topicsFor.current = sourceKey;
      setTopics(null);
      setFocus(null);
      // An answer for a choice that has since changed is dropped (topicsFor moved on). A failure counts as no
      // topics: the block hides, and this choice is not asked again.
      videosApi.focusTopics(fields)
        .then((r) => topicsFor.current === sourceKey && setTopics(r.topics))
        .catch(() => topicsFor.current === sourceKey && setTopics([]));
    }, 600);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey, sourceReady]);
  // Suggestions made for an earlier choice are never shown for this one: the cards wait for the new ones (and so
  // does Go to step 2). null = still loading; [] = none to show.
  const shownTopics = topicsFor.current === sourceKey ? topics : null;

  function options(): VideoOptions {
    const o: VideoOptions = { ...form };
    if (o.voice_gender === "none") delete o.custom_voice_id;
    return o;
  }

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      const from = sourceFields();
      if (!from) return;
      const a = await videosApi.create({ ...options(), ...from, ...(focus ? { focus: focus.title, focus_detail: focus.description } : {}) });
      navigate(`/app/videos/${a.id}`);
    } catch (e) {
      setError(errorMessage(e)); // 402 also opens the upgrade popup (api/client.ts)
      setBusy(false);
    }
  }

  if (loadError) {
    return (
      <div className={inModal ? "vw-in-modal" : "page-wrap"}>
        {!inModal && <PageHeader eyebrow="Videos" title="New video" />}
        <p className="error-text">{loadError}</p>
      </div>
    );
  }
  if (!config) return <Loading label="Loading" />;
  if (!config.configured) {
    return (
      <div className={inModal ? "vw-in-modal" : "page-wrap"}>
        {!inModal && <PageHeader eyebrow="Videos" title="New video" />}
        <p className="notice">Video is not set up on this server yet.</p>
      </div>
    );
  }

  const currentVoice = saved.find((v) => v.voice_id === form.custom_voice_id);

  return (
    <div className={inModal ? "stack vw-in-modal" : "page-wrap"}>
      {inModal ? (
        left !== null && <span className="mono muted small vw-modal-quota">{left} of {quota!.limit} video{quota!.limit === 1 ? "" : "s"} left</span>
      ) : (
        <PageHeader eyebrow="Videos" title="New video">
          {left !== null && (
            <span className="mono muted">{left} of {quota!.limit} video{quota!.limit === 1 ? "" : "s"} left</span>
          )}
        </PageHeader>
      )}

      {step === 1 && !inModal && (
        // Leaves the wizard for wherever it was opened from. Steps 2 and 3 have their own Back at the bottom.
        <button type="button" className="vw-back"
                onClick={() => (window.history.length > 1 ? navigate(-1) : navigate("/app/videos"))}>
          Back
        </button>
      )}
      <Steps step={step} />
      <section className={inModal ? "stack vw" : "card stack vw"}>

        {/* Stays mounted on steps 2 and 3, so going Back keeps the loaded posts and the ticks */}
        <div style={{ display: step === 1 ? "contents" : "none" }}>
          <SourcePicker source={source} onSource={setSource} postIds={postIds} onPostIds={setPostIds}
                        chatIds={chatIds} onChatIds={setChatIds} />
        </div>

        {step === 1 && (
          <>

            <div className="vw-row2">
              <div className="field">
                <span className="vw-label">Format</span>
                <div className="vw-formats" role="radiogroup" aria-label="Video format">
                  {FORMATS.map(({ id, name, label, Icon }) => (
                    <button key={id} type="button" role="radio" aria-checked={form.aspect_ratio === id} title={label}
                            className={form.aspect_ratio === id ? "on" : ""} onClick={() => set({ aspect_ratio: id })}>
                      <Icon />
                      {name}
                    </button>
                  ))}
                </div>
              </div>
              <div className="field">
                <span className="vw-label">Stock footage</span>
                <label className="vw-option">
                  <input type="checkbox" checked={form.stock_footage_enabled}
                         onChange={(e) => set({ stock_footage_enabled: e.target.checked })} />
                  Insert stock footage automatically
                </label>
              </div>
            </div>

            {error && <p className="error-text">{error}</p>}
            <div className="vw-nav">
              <button className="btn btn-primary vw-next" disabled={!sourceReady} onClick={() => setStep(2)}>
                Go to step 2
              </button>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <div>
              {catalog === null ? (
                <Loading label="Loading templates" />
              ) : shown.length === 0 ? (
                <p className="muted">No templates available.</p>
              ) : (
                <div className="vw-templates-scroll" ref={gridBox}>
                <div className="vw-templates">
                  {shown.map((t) => (
                    <button key={t.id} type="button" data-id={t.id} className={`vw-template${form.template === t.id ? " on" : ""}`}
                            aria-pressed={form.template === t.id} onClick={() => pickTemplate(t)}>
                      <TemplateThumb template={t} portrait={form.aspect_ratio === "portrait"} />
                      {t.id.startsWith("crafted_") ? <span className="vw-badge mono">Designer ★</span>
                        : t.custom ? <span className="vw-badge mono">Yours</span>
                        : (t.badge || t.popular_template) && <span className="vw-badge mono">{t.badge ?? "Popular"}</span>}
                      <strong>{t.name}</strong>
                      {form.template === t.id && <span className="vw-template-check" aria-hidden="true"><CheckIcon size={14} /></span>}
                    </button>
                  ))}
                </div>
                </div>
              )}
            </div>

            <div className="vw-style-row">
              <div className="field">
                <span className="vw-label">Video style</span>
                {catalog === null ? <Loading label="Loading styles" /> : (
                  <div className="vw-chips vw-style-chips">
                    {styles.map((s) => (
                      <button key={s.id} type="button" className={`vw-chip${form.video_style === s.id ? " on" : ""}`}
                              aria-pressed={form.video_style === s.id} title={s.description ?? undefined}
                              onClick={() => set({ video_style: s.id })}>
                        {s.name}{s.kind === "custom" ? " (yours)" : ""}
                      </button>
                    ))}
                  </div>
                )}
                {houseStyles && picked?.description && (
                  <small className="muted vw-style-note">{picked.description}</small>
                )}
              </div>

              <div className="field">
                <span className="vw-label">Video colors</span>
                <div className="vw-colors">
                  {([["accent_color", "Accent"], ["bg_color", "Background"], ["text_color", "Text"]] as const).map(([k, label]) => (
                    <label key={k} className="vw-color">
                      <input type="color" value={form[k] ?? "#000000"} onChange={(e) => set({ [k]: e.target.value })} aria-label={label} />
                      <span>{label}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>

            {/* Asked for on step 1, so usually here already. Hidden only when the request failed */}
            {sourceReady && shownTopics?.length !== 0 && (
              <div className="field vw-focus">
                <span className="vw-label">What should the video focus on?</span>
                <div className="vw-focus-grid" aria-busy={shownTopics === null}>
                  {shownTopics === null
                    ? [0, 1, 2].map((i) => (
                      <div key={i} className="vw-focus-card wait" aria-hidden="true">
                        <SparkleIcon size={18} />
                        <span className="vw-focus-text">
                          <span className="vw-focus-bar" />
                          <span className="vw-focus-bar short" />
                        </span>
                      </div>
                    ))
                    : shownTopics.map((t) => {
                      const on = focus?.title === t.title;
                      return (
                        <button key={t.title} type="button" className={`vw-focus-card${on ? " on" : ""}`}
                                aria-pressed={on} onClick={() => setFocus(on ? null : t)}>
                          <SparkleIcon size={18} />
                          <span className="vw-focus-text">
                            <strong>{t.title}</strong>
                            {t.description && <small className="vw-focus-desc">{t.description}</small>}
                          </span>
                          {on && <CheckIcon size={18} />}
                        </button>
                      );
                    })}
                </div>
                {shownTopics && (
                  <small className="muted vw-hint">
                    {focus ? "The video is mainly about this topic." : "None picked: the video covers the material as a whole."}
                  </small>
                )}
              </div>
            )}

            <div className="vw-nav">
              <button className="btn" onClick={() => setStep(1)}>Back</button>
              {/* Waits for the focus suggestions (shown, or none to show), so they are never skipped past */}
              <button className="btn btn-primary vw-next" disabled={shownTopics === null} onClick={() => setStep(3)}>
                Go to step 3
              </button>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <div className="field">
              <span className="vw-label">Language</span>
              {/* "" is Auto: the language is detected from the content */}
              <Dropdown
                label="Language"
                value={form.content_language ?? ""}
                options={[
                  { value: "", label: "Auto", hint: "Detect from the content" },
                  ...(catalog?.languages ?? []).map((l) => ({ value: l.code, label: l.name })),
                ]}
                onChange={(v) => set({ content_language: v || null })}
              />
              <small className="muted">Language of the video content</small>
            </div>

            <label className="vw-option">
              <input type="checkbox" checked={form.voice_gender === "none"}
                     onChange={(e) => {
                       if (e.target.checked) return set({ voice_gender: "none" });
                       const v = currentVoice ?? saved[0];
                       if (v) pickVoice(v);
                       else set({ voice_gender: "female" });
                     }} />
              No voiceover
            </label>

            <span className="vw-label">Voice: play to preview</span>

            <div className={`stack${form.voice_gender === "none" ? " vw-dim" : ""}`}>
              {voices === null ? (
                <Loading label="Loading voices" />
              ) : saved.length === 0 ? (
                <p className="muted">No voices saved yet. Add some on the <Link to="/app/videos/voices">Voices</Link> page.</p>
              ) : (
                <div className="vw-voice-list vw-voice-list-compact" role="radiogroup" aria-label="Narration voice">
                  {saved.map((v) => {
                    const on = form.custom_voice_id === v.voice_id && form.voice_gender !== "none";
                    return (
                      <div key={v.voice_id} className={`vw-vrow${on ? " on" : ""}`}>
                        <PlayButton on={playing === v.voice_id} disabled={!v.preview_url} label={v.name}
                                    onClick={() => play(v.voice_id, v.preview_url)} />
                        <button type="button" role="radio" aria-checked={on} className="vw-vpick"
                                disabled={form.voice_gender === "none"} onClick={() => pickVoice(v)}>
                          <strong>{v.name}</strong>
                          <span className="muted">{v.is_custom ? "Your voice" : [cap(v.gender), cap(v.accent)].filter(Boolean).join(" • ")}</span>
                        </button>
                        {on && <span className="vw-hero-check"><CheckIcon size={14} /></span>}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {error && <p className="error-text">{error}</p>}
            {left === 0 && (
              <p className="notice">
                You have used all your videos{quota?.resets_at ? " this period" : " on your plan"}.{" "}
                <button type="button" className="link-btn" onClick={() => openUpgrade()}>See plans</button>
              </p>
            )}
            <div className="vw-nav">
              <button className="btn" onClick={() => setStep(2)} disabled={busy}>Back</button>
              <button className="btn btn-primary vw-next" onClick={submit} disabled={busy}>
                {busy ? "Launching..." : "Generate Video"}
              </button>
            </div>
          </>
        )}
      </section>

    </div>
  );
}
