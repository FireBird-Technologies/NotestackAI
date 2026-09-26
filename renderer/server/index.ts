/**
 * Render service. POST /render accepts a validated props object, renders with Remotion, uploads
 * the result to Cloudflare R2 through the presigned PUT URL it was given (no R2 credentials
 * here), and reports progress back to the API.
 */
import { bundle } from "@remotion/bundler";
import { renderMedia, renderStill, selectComposition } from "@remotion/renderer";
import express from "express";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  audiogramSquareSchema,
  carouselSlideSchema,
  explainerLongSchema,
  quoteCardSchema,
  shortVerticalSchema,
} from "../src/schema";

const PORT = Number(process.env.PORT ?? 3100);
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN ?? "internal-change-me";
const ENTRY = path.resolve(process.cwd(), "src/index.ts");

const requestSchema = z.object({
  jobId: z.string(),
  compositionId: z.enum(["ShortVertical", "ExplainerLong", "AudiogramSquare", "QuoteCard", "CarouselSlide"]),
  props: z.record(z.unknown()),
  format: z.enum(["mp4", "png"]),
  uploadUrl: z.string().url(),
  uploadContentType: z.string(),
  callbackUrl: z.string().url(),
  storageKey: z.string(),
  // Carousels: one still per entry, each uploaded to its own presigned URL.
  stills: z
    .array(z.object({ props: z.record(z.unknown()), uploadUrl: z.string().url(), storageKey: z.string() }))
    .max(20)
    .optional(),
});
type RenderRequest = z.infer<typeof requestSchema>;

const propSchemas = {
  ShortVertical: shortVerticalSchema,
  ExplainerLong: explainerLongSchema,
  AudiogramSquare: audiogramSquareSchema,
  QuoteCard: quoteCardSchema,
  CarouselSlide: carouselSlideSchema,
} as const;

let bundlePromise: Promise<string> | null = null;
const getBundle = () => (bundlePromise ??= bundle({ entryPoint: ENTRY }));

async function report(req: RenderRequest, body: Record<string, unknown>) {
  try {
    await fetch(req.callbackUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-token": INTERNAL_TOKEN },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error("progress callback failed", err);
  }
}

async function upload(url: string, contentType: string, file: string) {
  const put = await fetch(url, { method: "PUT", headers: { "Content-Type": contentType }, body: await readFile(file) });
  if (!put.ok) throw new Error(`Storage upload failed: ${put.status}`);
}

async function runStills(req: RenderRequest) {
  const started = Date.now();
  const stills = req.stills ?? [];
  const serveUrl = await getBundle();
  const keys: string[] = [];
  for (const [i, still] of stills.entries()) {
    const out = path.join(tmpdir(), `${req.jobId}-${i}.png`);
    try {
      const inputProps = propSchemas[req.compositionId].parse(still.props);
      const composition = await selectComposition({ serveUrl, id: req.compositionId, inputProps });
      await renderStill({ composition, serveUrl, output: out, inputProps });
      await upload(still.uploadUrl, req.uploadContentType, out);
      keys.push(still.storageKey);
      await report(req, { status: "running", progress: 0.1 + (0.85 * (i + 1)) / stills.length, message: `Slide ${i + 1} of ${stills.length}` });
    } finally {
      await rm(out, { force: true });
    }
  }
  await report(req, {
    status: "done",
    progress: 1,
    message: "Liftoff",
    storage_key: keys[0],
    storage_keys: keys,
    render_seconds: (Date.now() - started) / 1000,
  });
}

async function run(req: RenderRequest) {
  if (req.stills?.length) {
    try {
      await report(req, { status: "running", progress: 0.05, message: "T-minus: bundling" });
      await runStills(req);
    } catch (err) {
      console.error("render failed", req.jobId, err);
      await report(req, { status: "failed", error: String(err).slice(0, 900), message: "Render failed" });
    }
    return;
  }
  const started = Date.now();
  const out = path.join(tmpdir(), `${req.jobId}.${req.format}`);
  try {
    const inputProps = propSchemas[req.compositionId].parse(req.props);
    await report(req, { status: "running", progress: 0.05, message: "T-minus: bundling" });
    const serveUrl = await getBundle();
    const composition = await selectComposition({ serveUrl, id: req.compositionId, inputProps });

    if (req.format === "png") {
      await renderStill({ composition, serveUrl, output: out, inputProps });
    } else {
      let last = 0;
      await renderMedia({
        composition,
        serveUrl,
        codec: "h264",
        outputLocation: out,
        inputProps,
        onProgress: ({ progress }) => {
          if (progress - last >= 0.05) {
            last = progress;
            const eta = progress > 0 ? Math.round(((Date.now() - started) / progress) * (1 - progress) / 1000) : null;
            void report(req, {
              status: "running",
              progress: 0.1 + progress * 0.8,
              message: eta !== null ? `T-minus ${eta}s` : "Rendering",
            });
          }
        },
      });
    }

    await report(req, { status: "running", progress: 0.95, message: "Uploading to storage" });
    await upload(req.uploadUrl, req.uploadContentType, out);

    await report(req, {
      status: "done",
      progress: 1,
      message: "Liftoff",
      storage_key: req.storageKey,
      render_seconds: (Date.now() - started) / 1000,
    });
  } catch (err) {
    console.error("render failed", req.jobId, err);
    await report(req, { status: "failed", error: String(err).slice(0, 900), message: "Render failed" });
  } finally {
    await rm(out, { force: true });
  }
}

const app = express();
app.use(express.json({ limit: "5mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/render", (req, res) => {
  if (req.header("x-internal-token") !== INTERNAL_TOKEN) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  void run(parsed.data); // async: API follows progress through callbacks
  res.status(202).json({ accepted: true, jobId: parsed.data.jobId });
});

app.listen(PORT, () => {
  console.log(`renderer listening on :${PORT}`);
  void getBundle(); // warm the bundle
});
