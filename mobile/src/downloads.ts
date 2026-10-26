import { ApiError, apiBytes } from "@notestack/shared/client";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { useState } from "react";

/** What each kind of file is, for the share sheet (Android's MIME type, iOS's UTI). */
const KINDS: Record<string, { mime: string; uti: string }> = {
  pdf: { mime: "application/pdf", uti: "com.adobe.pdf" },
  pptx: { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", uti: "org.openxmlformats.presentationml.presentation" },
  png: { mime: "image/png", uti: "public.png" },
  md: { mime: "text/markdown", uti: "net.daringfireball.markdown" },
  mp3: { mime: "audio/mpeg", uti: "public.mp3" },
  mp4: { mime: "video/mp4", uti: "public.mpeg-4" },
  zip: { mime: "application/zip", uti: "public.zip-archive" },
};

/** A file's extension ("pdf", "png"...). */
export type FileKind = string;

/** The extension a signed download link ends in (before its query), else `fallback`. */
export const extOf = (url: string, fallback: string) => /\.([a-z0-9]{2,5})(?:\?|#|$)/i.exec(url.split("?")[0])?.[1]?.toLowerCase() ?? fallback;

/** A file name the phone accepts: the title without odd characters, at most 80 long. */
export const fileName = (title: string, fallback: string) => title.replace(/[^\w\- ()]+/g, "").trim().slice(0, 80) || fallback;

/** Where the bytes come from: our API (signed in), any URL (a signed download link), or made here (a Markdown text, a
 * picture drawn as base64). */
export type FileSource = { api: string } | { url: string } | { text: string } | { base64: string };

/** Writes the file to the app's cache and hands it to the share sheet (Save to Files, AirDrop, another app). */
export async function saveFile(source: FileSource, name: string, kind: FileKind): Promise<void> {
  const file = new File(Paths.cache, `${name}.${kind}`);
  if (file.exists) file.delete();
  if ("url" in source) {
    await File.downloadFileAsync(source.url, file);
  } else {
    file.create();
    if ("base64" in source) await file.write(source.base64, { encoding: "base64" });
    else await file.write("text" in source ? source.text : new Uint8Array(await apiBytes(source.api)));
  }
  await Sharing.shareAsync(file.uri, { dialogTitle: name, mimeType: KINDS[kind]?.mime, UTI: KINDS[kind]?.uti });
}

/**
 * A download in progress (web: each card's download menu): `busy` names the one being prepared, so its button can
 * spin. `prepare` runs first (a viewer saves unsaved edits, so the file has them) and stops it when it returns false.
 */
export function useFileDownload<K extends string>(prepare?: () => Promise<boolean>) {
  const [busy, setBusy] = useState<K | null>(null);
  const [error, setError] = useState("");
  const save = async (key: K, source: FileSource | (() => FileSource | Promise<FileSource>), name: string, kind: FileKind) => {
    setBusy(key);
    setError("");
    try {
      if (prepare && !(await prepare())) return;
      await saveFile(typeof source === "function" ? await source() : source, name, kind);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not download it. Try again.");
    } finally {
      setBusy(null);
    }
  };
  return { busy, error, save };
}
