import { useEffect, useState, type FormEvent } from "react";
import { memoryApi } from "../api/endpoints";
import type { MemoryNote } from "../api/types";
import { ConfirmButton, errorMessage } from "./ui";

const EXAMPLES = [
  { key: "audience", value: "" },
  { key: "tone", value: "" },
  { key: "avoid", value: "" },
];

/** The writer's standing notes: what the research chat always knows, in every notebook. The chat also adds
 *  notes on its own when the writer says something lasting, and every note can be edited or removed here. */
export function MemoryNotes() {
  const [notes, setNotes] = useState<MemoryNote[] | null>(null);
  const [limit, setLimit] = useState(20);
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    memoryApi.list().then(
      (d) => {
        setNotes(d.items);
        setLimit(d.limit);
      },
      () => setError("Could not load your notes."),
    );

  useEffect(() => {
    void load();
  }, []);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await memoryApi.put(key, value);
      setKey("");
      setValue("");
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const edit = async (note: MemoryNote, next: string) => {
    if (next.trim() === note.value) return;
    setError(null);
    try {
      await memoryApi.put(note.key, next);
      await load();
    } catch (err) {
      setError(errorMessage(err));
      await load();
    }
  };

  const remove = async (note: MemoryNote) => {
    await memoryApi.remove(note.key);
    await load();
  };

  return (
    <>
      <p className="muted">
        Notes the assistant reads before every answer, in every notebook. It saves new ones when you tell it something
        lasting, like who you write for. Your posts stay the only source it cites.
      </p>
      {notes && notes.length === 0 && <p className="mono muted">No notes yet.</p>}
      {notes?.map((n) => (
        <div key={n.key} className="stack">
          <div className="row between">
            <span className="mono">{n.key}</span>
            <span className="row">
              <span className="mono muted small">{n.source === "auto" ? "saved from chat" : "written by you"}</span>
              <ConfirmButton onConfirm={() => remove(n)}>Delete</ConfirmButton>
            </span>
          </div>
          <input
            className="input input-sm"
            defaultValue={n.value}
            maxLength={500}
            aria-label={`Note ${n.key}`}
            onBlur={(e) => edit(n, e.target.value)}
          />
        </div>
      ))}
      <form className="stack" onSubmit={add}>
        <div className="row">
          {EXAMPLES.map((x) => (
            <button key={x.key} type="button" className="btn btn-small" onClick={() => setKey(x.key)}>
              {x.key}
            </button>
          ))}
        </div>
        <label className="field">
          <span>Name</span>
          <input className="input input-sm" placeholder="audience" maxLength={60} value={key} onChange={(e) => setKey(e.target.value)} />
        </label>
        <label className="field">
          <span>Note</span>
          <input
            className="input input-sm"
            placeholder="I write for indie founders"
            maxLength={500}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </label>
        <div className="row between">
          <span className="mono muted small">
            {notes?.length ?? 0} of {limit} notes
          </span>
          <button className="btn btn-small btn-primary" type="submit" disabled={!key.trim() || !value.trim() || (notes?.length ?? 0) >= limit}>
            Add note
          </button>
        </div>
      </form>
      {error && <p className="error-text">{error}</p>}
    </>
  );
}
