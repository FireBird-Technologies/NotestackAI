"""Typed DSPy signatures with Pydantic outputs. Phase 1 modules are implemented; later ones are
declared now so the output contract is fixed early."""

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
    Write in plain, warm prose. Never use em dashes."""

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
