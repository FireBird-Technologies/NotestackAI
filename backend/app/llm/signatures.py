"""Typed DSPy signatures with Pydantic outputs. Every module that produces facts cites SourceRefs,
which are verified against the corpus before anything reaches the writer."""

from typing import Literal

import dspy
from pydantic import BaseModel, Field

# Shared output models


class Section(BaseModel):
    heading: str | None = None
    text: str


class SourceRef(BaseModel):
    """A line range in a corpus file. Every generated fact points at one of these."""

    path: str = Field(description="Corpus path of the post, exactly as the tools showed it")
    line_start: int
    line_end: int


class FileCitation(SourceRef):
    marker: int = Field(description="The n in the [n] marker used in the answer")


class VoiceProfileOut(BaseModel):
    tone: list[str]
    sentence_length: Literal["short", "medium", "long", "varied"]
    vocabulary: list[str] = Field(description="Signature words and phrases the writer uses")
    structure_habits: list[str]
    openings: list[str] = Field(description="How the writer typically opens a piece")
    avoid: list[str] = Field(description="Things this writer never does")
    summary: str


class Claim(BaseModel):
    claim: str
    sources: list[SourceRef]


class ScriptLine(BaseModel):
    speaker: Literal["host_a", "host_b"]
    text: str
    sources: list[SourceRef] = Field(default_factory=list)


class Scene(BaseModel):
    type: Literal["title", "section", "pull_quote", "number", "outro"]
    on_screen_text: str
    narration: str
    duration_hint_s: float
    visual: str = ""


class Hook(BaseModel):
    text: str
    strength: float = Field(ge=0, le=1)
    rationale: str


class TopicTag(BaseModel):
    name: str = Field(description="Short topic name, 1 to 4 words, Title Case")
    weight: float = Field(ge=0, le=1, description="How central the topic is to the post")


class TopicGroup(BaseModel):
    canonical: str = Field(description="The best name for the merged topic")
    members: list[str] = Field(description="Every input name that means the same topic")
    summary: str = Field(description="One sentence on what the writer says about it")


class InternalLink(BaseModel):
    path: str
    anchor_text: str
    reason: str


class SeoPackOut(BaseModel):
    title_options: list[str]
    meta_description: str = Field(description="At most 155 characters")
    slug: str
    keywords: list[str]
    internal_links: list[InternalLink] = Field(default_factory=list)


class Slide(BaseModel):
    heading: str
    body: str


class QuotePick(BaseModel):
    quote: str = Field(description="Exact words from the passage, at most 220 characters")
    source: SourceRef


# Signatures


class CleanAndSegment(dspy.Signature):
    """Turn a raw blog post into clean sections with headings. Keep the writer's words; drop
    navigation, subscribe prompts, footers and share buttons."""

    title: str = dspy.InputField()
    raw_text: str = dspy.InputField()
    sections: list[Section] = dspy.OutputField()


class ResearchArchive(dspy.Signature):
    """You are a research assistant working inside a writer's archive, which is a folder of markdown
    posts. Find the answer by exploring the files: list_files to see what exists, search (a regex
    grep; try several phrasings and synonyms) to locate relevant lines, then read the surrounding
    lines before relying on them. Answer ONLY from text you read. Every factual sentence needs a
    [n] marker, and every marker needs a citation with the file path and the line range you read.
    If the archive does not cover the question, say so plainly and set unsupported=true.
    Write in plain, warm prose formatted as Markdown: short paragraphs separated by blank lines,
    bullet or numbered lists when comparing or listing things, **bold** for the key idea, and a
    ### heading only when the answer has distinct parts. Put [n] markers right after the sentence
    or list item they support. Never use em dashes."""

    question: str = dspy.InputField()
    archive_guide: str = dspy.InputField(desc="How this notebook's files are laid out")
    answer: str = dspy.OutputField(desc="Answer with [n] citation markers")
    citations: list[FileCitation] = dspy.OutputField()
    unsupported: bool = dspy.OutputField()


class GroundednessJudge(dspy.Signature):
    """Decide whether the sentence is fully supported by the cited passages."""

    sentence: str = dspy.InputField()
    passages: list[str] = dspy.InputField()
    supported: bool = dspy.OutputField()


class BuildVoiceProfile(dspy.Signature):
    """Describe the writer's style from their sample posts so other modules can write like them."""

    samples: list[str] = dspy.InputField()
    profile: VoiceProfileOut = dspy.OutputField()


class ExtractClaims(dspy.Signature):
    """List the key claims of the post, each with the passages that support it."""

    passages: list[str] = dspy.InputField(desc="Post text with path and line numbers")
    claims: list[Claim] = dspy.OutputField()


class PodcastScript(dspy.Signature):
    """Write a two host conversation about the material. Hosts stay grounded in the passages and cite
    them. Natural, warm, curious. No em dashes."""

    passages: list[str] = dspy.InputField()
    format: Literal["deep_dive", "brief", "debate"] = dspy.InputField()
    target_minutes: int = dspy.InputField()
    lines: list[ScriptLine] = dspy.OutputField()


class VideoStoryboard(dspy.Signature):
    """Turn the post into a scene list for a Remotion composition."""

    passages: list[str] = dspy.InputField()
    aspect: Literal["16:9", "9:16", "1:1"] = dspy.InputField()
    scenes: list[Scene] = dspy.OutputField()


class HookGenerator(dspy.Signature):
    """Write scroll stopping hooks for the post in the writer's voice. No em dashes."""

    passages: list[str] = dspy.InputField()
    voice_profile: str = dspy.InputField()
    n: int = dspy.InputField()
    hooks: list[Hook] = dspy.OutputField()


class PlatformAdapter(dspy.Signature):
    """Adapt claims into a native post for the platform, in the writer's voice, following the rules."""

    claims: list[Claim] = dspy.InputField()
    voice_profile: str = dspy.InputField()
    platform: Literal["x_thread", "linkedin", "substack_notes", "bluesky"] = dspy.InputField()
    platform_rules: str = dspy.InputField()
    posts: list[str] = dspy.OutputField()


class SummarizeNotebook(dspy.Signature):
    """Summarize what these posts say as a whole: the main arguments, how they connect and where the
    writer changed their mind. Every factual sentence ends with a [n] marker and a citation to the
    lines it came from. Plain, warm prose. Never use em dashes."""

    title: str = dspy.InputField()
    passages: list[str] = dspy.InputField(desc="Posts with path and numbered lines")
    summary: str = dspy.OutputField(desc="Markdown: 3 to 6 short paragraphs or sections (### headings allowed), "
                                         "blank lines between blocks, [n] markers after supported sentences")
    themes: list[str] = dspy.OutputField(desc="3 to 7 short theme names")
    citations: list[FileCitation] = dspy.OutputField()


class ExtractTopics(dspy.Signature):
    """Name the topics this post is about, the way a reader would search for them."""

    title: str = dspy.InputField()
    text: str = dspy.InputField()
    known_topics: list[str] = dspy.InputField(desc="Reuse one of these names when it fits")
    topics: list[TopicTag] = dspy.OutputField(desc="3 to 8 topics")


class ConsolidateTopics(dspy.Signature):
    """Merge topic names that mean the same thing (plural/singular, synonyms, broader wording) and
    write a one sentence summary per merged topic from the post titles given."""

    topics: list[str] = dspy.InputField(desc="name (post count): sample post titles")
    groups: list[TopicGroup] = dspy.OutputField()


class SeoPack(dspy.Signature):
    """Write search metadata for the post in the writer's voice and suggest links to their other
    posts where a reader would want them. No em dashes."""

    title: str = dspy.InputField()
    passages: list[str] = dspy.InputField()
    related_posts: str = dspy.InputField(desc="Other posts in the archive as date | path | title")
    seo: SeoPackOut = dspy.OutputField()


class CarouselSlides(dspy.Signature):
    """Turn the post's key claims into a 6 to 9 slide carousel. Slide 1 is a hook, the last is a call to
    read the post. Short, punchy, in the writer's voice. No em dashes."""

    passages: list[str] = dspy.InputField()
    voice_profile: str = dspy.InputField()
    slides: list[Slide] = dspy.OutputField()


class PickQuotes(dspy.Signature):
    """Pick the most quotable lines, copied exactly from the passages."""

    passages: list[str] = dspy.InputField()
    n: int = dspy.InputField()
    quotes: list[QuotePick] = dspy.OutputField()


class EvergreenScore(dspy.Signature):
    """Judge how well this post would land if reshared today. Evergreen means the ideas are not tied to
    news, dates or a moment. Suggest a fresh angle for resharing it. No em dashes."""

    title: str = dspy.InputField()
    published: str = dspy.InputField()
    excerpt: str = dspy.InputField()
    score: float = dspy.OutputField(desc="0 (dated) to 1 (timeless)")
    reason: str = dspy.OutputField()
    angle: str = dspy.OutputField(desc="One line hook for resharing now")
