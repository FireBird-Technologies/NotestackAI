"""Slide decks: the model writes a deck as JSON (content.py clamps it to a fixed shape), layout.py places every slide
on a 1920 x 1080 canvas, and the same placed elements are drawn as HTML (render.py: preview, presenting, PDF) and as
an editable PowerPoint (export.py). The model never writes markup or picks positions, colours or sizes."""
