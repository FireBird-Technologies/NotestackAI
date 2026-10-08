import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useLocation } from "react-router-dom";
import { supportApi, type DonePayload, type EscalateReason } from "../../api/support";
import { useAuth } from "../../hooks/useAuth";
import { Markdown } from "../Markdown";

type Msg = {
  role: "user" | "assistant";
  text: string;
  streaming?: boolean;
  escalate?: boolean;
  reason?: EscalateReason | null;
};

const STARTERS = [
  "How do I add my blog?",
  "How do I make an audio overview?",
  "What is in the free plan?",
];

const FORM_COPY: Record<EscalateReason, string> = {
  human: "Talk to a human",
  refund: "Talk to a human",
  feature: "Request this feature",
};

function EscalationForm({ reason, concern, page, conversationId, defaultEmail, open }: {
  reason: EscalateReason;
  concern: string;
  page: string;
  conversationId: string | null;
  defaultEmail: string;
  open: boolean;
}) {
  const [show, setShow] = useState(open);
  const [email, setEmail] = useState(defaultEmail);
  const [text, setText] = useState(concern);
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState("");

  if (state === "sent") return <p className="sup-note ok">Thanks. We will email you back shortly.</p>;
  if (!show) {
    return (
      <button type="button" className="btn btn-small btn-primary sup-escalate" onClick={() => setShow(true)}>
        {FORM_COPY[reason]}
      </button>
    );
  }
  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !text.trim() || state === "sending") return;
    setState("sending");
    setError("");
    try {
      await supportApi.escalate({ email: email.trim(), concern: text.trim(), reason, page_path: page, conversation_id: conversationId });
      setState("sent");
    } catch (err) {
      setState("idle");
      setError(err instanceof Error ? err.message : "Could not send. Please try again.");
    }
  };
  return (
    <form className="sup-form" onSubmit={send}>
      <label>
        Your email
        <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
      </label>
      <label>
        {reason === "feature" ? "What would you like us to build?" : "What do you need?"}
        <textarea className="input" rows={3} value={text} onChange={(e) => setText(e.target.value)} maxLength={4000} required />
      </label>
      {error && <p className="sup-note err">{error}</p>}
      <button className="btn btn-small btn-primary" disabled={state === "sending"}>
        {state === "sending" ? "Sending..." : "Send to the team"}
      </button>
    </form>
  );
}

export function SupportChat({ onClose }: { onClose: () => void }) {
  const { user } = useAuth();
  const { pathname, search } = useLocation();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState(Boolean(user));
  const bottom = useRef<HTMLDivElement>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!user) return;
    let alive = true;
    supportApi
      .latest()
      .then((d) => {
        if (!alive) return;
        setConversationId(d.conversation_id);
        setMessages(d.messages.map((m) => ({ role: m.role, text: m.content })));
      })
      .catch(() => undefined)
      .finally(() => alive && setRestoring(false));
    return () => {
      alive = false;
      abort.current?.abort();
    };
  }, [user]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [messages]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  const update = (patch: Partial<Msg>) =>
    setMessages((all) => all.map((m, i) => (i === all.length - 1 ? { ...m, ...patch } : m)));

  const ask = async (raw: string) => {
    const message = raw.trim();
    if (!message || busy) return;
    setInput("");
    setBusy(true);
    setMessages((all) => [...all, { role: "user", text: message }, { role: "assistant", text: "", streaming: true }]);
    abort.current = new AbortController();
    let text = "";
    await supportApi.chat(
      { message, page_path: pathname + search, conversation_id: conversationId },
      {
        onToken: (t) => {
          text += t;
          update({ text });
        },
        onAnswerDone: () => {
          update({ streaming: false });
          setBusy(false);
        },
        onDone: (d: DonePayload) => {
          setConversationId(d.conversation_id);
          update({ escalate: d.escalate, reason: d.escalate_reason, streaming: false });
          setBusy(false);
        },
        onError: (m) => {
          update({ text: text || m, streaming: false });
          setBusy(false);
        },
      },
      abort.current.signal,
    );
    setBusy(false);
  };

  const newChat = () => {
    abort.current?.abort();
    setMessages([]);
    setConversationId(null);
    setBusy(false);
  };

  return (
    <section className="sup-panel" role="dialog" aria-label="Help">
      <header className="sup-head">
        <div>
          <strong>Notestack help</strong>
          <span className="muted small">How to use the app</span>
        </div>
        <div className="sup-head-actions">
          {messages.length > 0 && <button type="button" className="link-btn small" onClick={newChat}>New chat</button>}
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close help">×</button>
        </div>
      </header>

      {!user ? (
        <div className="sup-empty">
          <p>Sign in to ask how anything in Notestack works.</p>
          <Link className="btn btn-primary" to={`/auth?${new URLSearchParams({ next: pathname })}`} onClick={onClose}>Sign in</Link>
        </div>
      ) : (
        <>
          <div className="sup-body" aria-live="polite">
            {restoring ? (
              <p className="muted small">Loading...</p>
            ) : messages.length === 0 ? (
              <div className="sup-empty">
                <p>Ask me how to do anything in Notestack.</p>
                <p className="muted small">I cannot see your notebooks or posts. For questions about your writing, ask in the notebook chat.</p>
                <div className="sup-starters">
                  {STARTERS.map((s) => (
                    <button key={s} type="button" className="sup-starter" onClick={() => ask(s)}>{s}</button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((m, i) => (
                <div key={i} className={`sup-msg ${m.role}`}>
                  {m.role === "user" ? (
                    <p>{m.text}</p>
                  ) : m.streaming && !m.text ? (
                    <span className="sup-typing" aria-label="Thinking"><i /><i /><i /></span>
                  ) : (
                    <Markdown text={m.text} />
                  )}
                  {m.role === "assistant" && !m.streaming && (
                    <>
                      {m.escalate && m.reason && (
                        <EscalationForm
                          reason={m.reason}
                          concern={m.reason === "feature" ? messages[i - 1]?.text ?? "" : ""}
                          page={pathname}
                          conversationId={conversationId}
                          defaultEmail={user.email}
                          open={m.reason !== "feature"}
                        />
                      )}
                    </>
                  )}
                </div>
              ))
            )}
            <div ref={bottom} />
          </div>
          <form className="sup-ask" onSubmit={(e: FormEvent) => { e.preventDefault(); void ask(input); }}>
            <input
              className="input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="How do I..."
              aria-label="Ask for help"
              maxLength={4000}
            />
            <button className="btn btn-primary" disabled={busy || !input.trim()}>Send</button>
          </form>
        </>
      )}
    </section>
  );
}
