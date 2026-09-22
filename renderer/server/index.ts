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
import { quoteCardSchema, shortVerticalSchema } from "../src/schema";

const PORT = Number(process.env.PORT ?? 3100);
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN ?? "internal-change-me";
const ENTRY = path.resolve(process.cwd(), "src/index.ts");

const requestSchema = z.object({
  jobId: z.string(),
  compositionId: z.enum(["ShortVertical", "QuoteCard"]),
  props: z.record(z.unknown()),
  format: z.enum(["mp4", "png"]),
  uploadUrl: z.string().url(),
  uploadContentType: z.string(),
  callbackUrl: z.string().url(),
  storageKey: z.string(),
});
type RenderRequest = z.infer<typeof requestSchema>;

const propSchemas = { ShortVertical: shortVerticalSchema, QuoteCard: quoteCardSchema } as const;

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

async function run(req: RenderRequest) {
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
    const data = await readFile(out);
    const put = await fetch(req.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": req.uploadContentType },
      body: data,
    });
    if (!put.ok) throw new Error(`R2 upload failed: ${put.status}`);

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
