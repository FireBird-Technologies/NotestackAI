import { z } from "zod";

// Shared props schema. The backend builds these (app/pipeline/media.py); every composition validates
// its props before rendering.

export const brandSchema = z
  .object({
    accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    logoUrl: z.string().url().optional(),
    name: z.string().optional(),
  })
  .default({});

export const captionWordSchema = z.object({ text: z.string(), startMs: z.number(), endMs: z.number() });

export const sceneSchema = z.object({
  type: z.enum(["title", "section", "pull_quote", "number", "outro"]).catch("section"),
  onScreenText: z.string(),
  narration: z.string().default(""),
  durationS: z.number().min(0.5).max(60),
  citation: z.string().optional(),
});

export const shortVerticalSchema = z.object({
  hook: z.string().max(120),
  scenes: z.array(sceneSchema).min(1),
  captions: z.array(captionWordSchema).default([]),
  audioUrl: z.string().url().optional(),
  brand: brandSchema,
});

export const explainerLongSchema = z.object({
  title: z.string().max(140),
  scenes: z.array(sceneSchema).min(1),
  captions: z.array(captionWordSchema).default([]),
  audioUrl: z.string().url().optional(),
  brand: brandSchema,
});

export const segmentSchema = z.object({
  speaker: z.string(),
  text: z.string(),
  startMs: z.number(),
  endMs: z.number(),
});

export const audiogramSquareSchema = z.object({
  title: z.string().max(140),
  audioUrl: z.string().url(),
  durationS: z.number().min(1).max(600),
  segments: z.array(segmentSchema).default([]),
  brand: brandSchema,
});

export const quoteCardSchema = z.object({
  quote: z.string().max(400),
  author: z.string(),
  publication: z.string().optional(),
  brand: brandSchema,
});

export const carouselSlideSchema = z.object({
  heading: z.string().max(120),
  body: z.string().max(500).default(""),
  index: z.number().int().min(1),
  total: z.number().int().min(1),
  brand: brandSchema,
});

export type ShortVerticalProps = z.infer<typeof shortVerticalSchema>;
export type ExplainerLongProps = z.infer<typeof explainerLongSchema>;
export type AudiogramSquareProps = z.infer<typeof audiogramSquareSchema>;
export type QuoteCardProps = z.infer<typeof quoteCardSchema>;
export type CarouselSlideProps = z.infer<typeof carouselSlideSchema>;
export type Scene = z.infer<typeof sceneSchema>;

export const FPS = 30;
