"""The report templates offered in the Create report dialog. Each one is the instruction text the writer is given; the
dialog fills {about} in with the report's topic (or the chosen sources) and lets the user edit the whole text before it
is sent. Kept on the server so the dialog and the generator share one source of truth."""

INTERACTIVE_ID = "interactive"
CUSTOM_ID = "custom"

TEMPLATES: list[dict] = [
    {
        "id": CUSTOM_ID,
        "name": "Create Your Own",
        "description": "Craft reports your way by specifying structure, style, tone, and more",
        "prompt": "",
    },
    {
        "id": "briefing",
        "name": "Briefing Doc",
        "description": "Overview of your sources featuring key insights and quotes",
        "prompt": ("You are a highly capable research assistant. Write a briefing document on {about}. Open with a "
                   "short Introduction, then give the key insights under clear, descriptive headings, and include the best "
                   "short quotes from the sources that support them. End with a Summary of the main takeaways."),
    },
    {
        "id": "study_guide",
        "name": "Study Guide",
        "description": "Short-answer quiz, suggested essay questions, and glossary of key terms",
        "prompt": ("You are a highly capable research assistant and tutor. Create a detailed study guide on {about} "
                   "designed to review understanding of the sources. Create a quiz with ten short-answer questions "
                   "(2-3 sentences each) and include a separate answer key. Suggest five essay format questions, "
                   "but do not supply answers. Also conclude with a comprehensive glossary of key terms with "
                   "definitions. Start with an Introduction that says what the reader will be able to do by the end, and give "
                   "every section a relevant, specific heading."),
    },
    {
        "id": "blog_post",
        "name": "Blog Post",
        "description": "Insightful takeaways distilled into a highly readable article",
        "prompt": ("Write an engaging blog post on {about}. Distill the most insightful takeaways from the sources "
                   "into a highly readable article with a strong opening, short sections with clear subheadings, "
                   "concrete examples from the sources, and a closing thought. Give every section a relevant, specific heading. Keep "
                   "the tone warm and conversational."),
    },
]

INTERACTIVE = {
    "id": INTERACTIVE_ID,
    "name": "Interactive report",
    "description": "An interactive report with embedded studio content",
    "prompt": ("Create an interactive report on {about}. Explain it clearly in well organised sections, starting "
               "with an Introduction and ending with a Summary, and give every section a relevant, specific heading. "
               "Suggest where a visual would help the reader, such as a mind map of how the ideas connect, flashcards "
               "for the key terms, a short quiz, a comparison table or a timeline."),
}

DEFAULT_ABOUT = "the selected sources"


def get_template(template_id: str | None) -> dict | None:
    if template_id == INTERACTIVE_ID:
        return INTERACTIVE
    return next((t for t in TEMPLATES if t["id"] == template_id), None)


def fill_prompt(template: dict, about: str | None = None) -> str:
    """The template's instruction text for a report about `about` (the topic, or the sources when there is none)."""
    return template["prompt"].replace("{about}", (about or "").strip() or DEFAULT_ABOUT)


def default_instructions(report_format: str, template_id: str | None, about: str | None = None) -> str:
    """What the writer is told when the dialog sent no instructions of its own."""
    template = get_template(INTERACTIVE_ID if report_format == "interactive" else template_id)
    if template and template["prompt"]:
        return fill_prompt(template, about)
    return f"Write a clear, well organised report on {(about or '').strip() or DEFAULT_ABOUT}."
