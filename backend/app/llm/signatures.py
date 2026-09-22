"""Typed DSPy signatures with Pydantic outputs. Phase 1 modules are implemented; later ones are
declared now so the output contract is fixed early."""

from typing import Literal

import dspy
from pydantic import BaseModel, Field

# Shared output models


class Section(BaseModel):
    heading: str | None = None
    text: str


class CitedSentence(BaseModel):
    sentence: str
    chunk_ids: list[int] = Field(description="Indices of supporting passages from the context list")


class GroundedAnswerOut(BaseModel):
    answer: str = Field(description="Answer text with [n] markers that refer to passage indices")
    sentences: list[CitedSentence]
    unsupported: bool = Field(description="True if the passages do not contain enough to answer")


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
    chunk_ids: list[int]


class ScriptLine(BaseModel):
    speaker: Literal["host_a", "host_b"]
    text: str
    chunk_ids: list[int] = Field(default_factory=list)


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


class GroundedAnswer(dspy.Signature):
    """Answer the question using ONLY the numbered passages. Every factual sentence must cite at least
    one passage with [n]. If the passages do not support an answer, say so and set unsupported=true.
    Never use em dashes."""

    question: str = dspy.InputField()
    passages: list[str] = dspy.InputField(desc="Numbered passages from the writer's own posts")
    result: GroundedAnswerOut = dspy.OutputField()


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

    passages: list[str] = dspy.InputField()
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
