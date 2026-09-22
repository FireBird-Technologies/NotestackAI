import { z } from "zod";

// Shared props schema. The backend VideoStoryboard signature produces this shape; every
// composition validates its props before rendering.

export const brandSchema = z
  .object({
    accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    logoUrl: z.string().url().optional(),
    name: z.string().optional(),
  })
  .default({});

export const captionWordSchema = z.object({ text: z.string(), startMs: z.number(), endMs: z.number() });

export const sceneSchema = z.object({
  type: z.enum(["title", "section", "pull_quote", "number", "outro"]),
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

export const quoteCardSchema = z.object({
  quote: z.string().max(400),
  author: z.string(),
  publication: z.string().optional(),
  brand: brandSchema,
});

export type ShortVerticalProps = z.infer<typeof shortVerticalSchema>;
export type QuoteCardProps = z.infer<typeof quoteCardSchema>;

export const FPS = 30;
