from types import SimpleNamespace

from app.pipeline import report, report_visuals


def _material(lines, document=None):
    def refs(items):
        out = []
        for item in items or []:
            quote = lines.get((item.get("path"), item.get("line_start"), item.get("line_end")))
            if quote:
                out.append({**item, "document_id": "d1", "title": "Metrics", "quote": quote})
        return out

    return SimpleNamespace(title="Test report", docs=[document or object()], text=["numbered source"], mode="passages", refs=refs)


def test_extract_keeps_only_values_that_exist_in_verified_source_lines(monkeypatch):
    source = {("metrics.md", 10, 10): "2023 revenue was $12.4 million.",
              ("metrics.md", 11, 11): "2024 revenue was $15.1 million."}
    candidates = [{"kind": "bar", "title": "Revenue", "x_label": "Year", "y_label": "Revenue", "unit": "",
                   "points": [
                       {"label": "2023", "value": "$12.4", "sources": [{"path": "metrics.md", "line_start": 10, "line_end": 10}]},
                       {"label": "2024", "value": "$15.1", "sources": [{"path": "metrics.md", "line_start": 11, "line_end": 11}]},
                   ]}]
    seen = {}
    monkeypatch.setattr(report_visuals.run, "predict",
                        lambda *_args, **kwargs: seen.update(kwargs) or {"candidates": candidates})
    out = report_visuals.extract(SimpleNamespace(), "workspace", None, _material(source), focus="Revenue report")
    assert seen["focus"] == "Revenue report"
    assert out[0]["block"]["points"] == [
        {"label": "2023", "value": 12.4, "display_value": "$12.4", "detail": ""},
        {"label": "2024", "value": 15.1, "display_value": "$15.1", "detail": ""},
    ]


def test_extract_rejects_a_whole_plot_when_one_number_is_invented(monkeypatch):
    source = {("metrics.md", 10, 10): "2023 revenue was $12.4 million.",
              ("metrics.md", 11, 11): "2024 revenue was $15.1 million."}
    candidates = [{"kind": "line", "title": "Revenue", "points": [
        {"label": "2023", "value": "$12.4", "sources": [{"path": "metrics.md", "line_start": 10, "line_end": 10}]},
        {"label": "2024", "value": "$99.9", "sources": [{"path": "metrics.md", "line_start": 11, "line_end": 11}]},
    ]}]
    monkeypatch.setattr(report_visuals.run, "predict", lambda *_args, **_kwargs: {"candidates": candidates})
    assert report_visuals.extract(SimpleNamespace(), "workspace", None, _material(source)) == []


def test_source_exact_market_formats_are_parsed_without_weakening_verification(monkeypatch):
    source = {("market.md", 80, 80): "1 day 0.97% 10 years ‪13.82 K‬%",
              ("market.md", 88, 90): "AVGO 357.31USD", ("market.md", 92, 94): "NVDA 228.52USD"}
    candidates = [
        {"kind": "bar", "title": "Returns", "unit": "%", "points": [
            {"label": "1 day", "value": "0.97%", "sources": [{"path": "market.md", "line_start": 80, "line_end": 80}]},
            {"label": "10 years", "value": "‪13.82 K‬%", "sources": [{"path": "market.md", "line_start": 80, "line_end": 80}]},
        ], "sources": [{"path": "market.md", "line_start": 80, "line_end": 80}]},
        {"kind": "bar", "title": "Prices", "unit": "USD", "points": [
            {"label": "AVGO", "value": "357.31USD", "sources": [{"path": "market.md", "line_start": 88, "line_end": 90}]},
            {"label": "NVDA", "value": "228.52USD", "sources": [{"path": "market.md", "line_start": 92, "line_end": 94}]},
        ], "sources": [{"path": "market.md", "line_start": 88, "line_end": 94}]},
    ]
    monkeypatch.setattr(report_visuals.run, "predict", lambda *_args, **_kwargs: {"candidates": candidates})
    out = report_visuals.extract(SimpleNamespace(), "workspace", None, _material(source))
    assert [item["block"]["points"][1]["value"] for item in out] == [13_820, 228.52]


def test_a_grounded_two_column_table_can_use_safe_generic_headers(monkeypatch):
    source = {("stats.md", 10, 12): "Market capitalization\n5.51 TUSD",
              ("stats.md", 14, 16): "Revenue (FY)\n215.94 BUSD"}
    candidate = {"kind": "table", "title": "Stats", "headers": [], "rows": [
        {"cells": ["Market capitalization", "5.51 TUSD"],
         "sources": [{"path": "stats.md", "line_start": 10, "line_end": 12}]},
        {"cells": ["Revenue (FY)", "215.94 BUSD"],
         "sources": [{"path": "stats.md", "line_start": 14, "line_end": 16}]},
    ]}
    monkeypatch.setattr(report_visuals.run, "predict", lambda *_args, **_kwargs: {"candidates": [candidate]})
    out = report_visuals.extract(SimpleNamespace(), "workspace", None, _material(source))
    assert out[0]["block"]["headers"] == ["Metric", "Value"]


def test_chat_only_material_never_gets_an_unverifiable_visual(monkeypatch):
    material = SimpleNamespace(docs=[], text=["Chat says revenue doubled"], mode="passages", refs=lambda _: [])
    monkeypatch.setattr(report_visuals.run, "predict", lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError()))
    assert report_visuals.extract(SimpleNamespace(), "workspace", None, material) == []


def test_an_explicit_markdown_table_is_detected_even_when_the_model_fails(monkeypatch):
    source = {("metrics.md", 8, 8): "| Year | Revenue |", ("metrics.md", 10, 10): "| 2023 | $12.4 |",
              ("metrics.md", 11, 11): "| 2024 | $15.1 |"}
    material = _material(source)
    material.text = ["FILE metrics.md (Metrics)\n8| | Year | Revenue |\n9| | --- | --- |\n"
                     "10| | 2023 | $12.4 |\n11| | 2024 | $15.1 |"]
    monkeypatch.setattr(report_visuals.run, "predict", lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError()))
    out = report_visuals.extract(SimpleNamespace(), "workspace", None, material)
    assert out[0]["block"]["type"] == "table"
    assert out[0]["block"]["headers"] == ["Year", "Revenue"]
    assert out[0]["block"]["rows"] == [["2023", "$12.4"], ["2024", "$15.1"]]


def test_post_dataset_cache_keeps_meaning_and_is_revalidated_before_report_use(monkeypatch):
    source = {
        ("growth.md", 10, 10): "Year-end newsletter subscribers were 4,100 in 2023.",
        ("growth.md", 11, 11): "Year-end newsletter subscribers were 6,200 in 2024.",
    }
    document = SimpleNamespace(id="d1", path="growth.md", content_hash="hash-1", metadata_json={})
    material = _material(source, document)
    raw = {"kind": "line", "title": "newsletter subscribers", "description": "Year-end newsletter subscribers",
           "metric": "subscribers", "dimension": "", "population": "newsletter", "qualifiers": ["Year-end"],
           "points": [
               {"label": "2023", "value": "4,100", "sources": [
                   {"path": "growth.md", "line_start": 10, "line_end": 10}]},
               {"label": "2024", "value": "6,200", "sources": [
                   {"path": "growth.md", "line_start": 11, "line_end": 11}]},
           ], "sources": [{"path": "growth.md", "line_start": 10, "line_end": 11}]}
    cached = report_visuals.cache_post_datasets(document, material, [raw])
    assert cached[0]["content_hash"] == "hash-1"
    assert cached[0]["meaning"]["description"] == "Year-end newsletter subscribers"
    assert cached[0]["meaning"]["qualifiers"] == ["Year-end"]
    assert len(cached[0]["meaning"]["source_excerpts"]) == 2

    document.metadata_json = {"datasets": cached, "datasets_hash": "hash-1",
                              "datasets_schema": report_visuals.DATASET_SCHEMA}
    monkeypatch.setattr(report_visuals.run, "predict", lambda *_args, **_kwargs: {"candidates": []})
    out = report_visuals.extract(SimpleNamespace(), "workspace", None, material, focus="newsletter subscribers")
    assert out[0]["block"]["points"][1]["value"] == 6200
    assert "meaning: description=Year-end newsletter subscribers" in report_visuals.opportunity_lines(out)[0]

    # A hash match alone is not trusted: if the cited lines no longer contain the values, revalidation drops the cache.
    changed = _material({("growth.md", 10, 11): "The figures were removed."}, document)
    assert report_visuals.cached_candidates(changed, focus="newsletter subscribers") == []


def test_a_clicked_suggestion_resolves_only_its_stored_validated_block():
    block = {"type": "plot", "title": "Source data", "plot_kind": "bar", "points": [
        {"label": "2023", "value": 12.4}, {"label": "2024", "value": 15.1},
    ]}
    content = {"visual_candidates": [{"id": "v1", "block": block}],
               "suggestions": [{"id": "s1", "kind": "plot", "candidate_id": "v1"}]}
    assert report_visuals.candidate_block(content, "s1", "plot") == block
    assert report_visuals.candidate_block(content, "s1", "table") is None
    assert report_visuals.candidate_block(content, "made-up", "plot") is None

    made = report.make_block(SimpleNamespace(), SimpleNamespace(), SimpleNamespace(content_json=content),
                             "plot", "ignored client text", suggestion_id="s1")
    inserted = report.insert_block({"blocks": [{"id": "b1", "type": "prose", "text": "Report"}], **content},
                                   {"type": "plot", **made}, "b1", "s1")
    assert [item["type"] for item in inserted["blocks"]] == ["prose", "plot"]
    assert inserted["blocks"][1]["points"] == block["points"]
    assert inserted["suggestions"] == []


def test_verified_data_is_described_for_planning_and_matched_to_the_relevant_section():
    candidate = {"id": "v1", "block": {"type": "plot", "title": "Subscriber growth", "plot_kind": "line",
                                           "x_label": "Year", "y_label": "Subscribers", "points": [
        {"label": "2023", "value": 4100, "display_value": "4,100"},
        {"label": "2024", "value": 6200, "display_value": "6,200"},
    ]}}
    lines = report_visuals.opportunity_lines([candidate])
    assert lines == ["v1 | line plot | Subscriber growth | 2023 = 4,100; 2024 = 6,200"]
    assert report_visuals.evidence(candidate) == [f"VERIFIED DATA FOR THIS SECTION: {lines[0]}"]
    sections = [
        {"heading": "Pricing strategy", "brief": "How pricing changed", "must_cover": ["plans"]},
        {"heading": "Subscriber growth", "brief": "How the audience expanded", "must_cover": ["subscriber totals"]},
    ]
    assert report_visuals.best_section(candidate, sections) == 1


def test_verified_data_is_linked_to_the_theme_owning_its_source_posts():
    candidate = {"id": "v1", "block": {"type": "plot", "title": "Subscriber growth", "plot_kind": "line",
                                           "source_refs": [{"document_id": "growth-post"}], "points": [
        {"label": "2023", "value": 4100}, {"label": "2024", "value": 6200},
    ]}}
    themes = [
        SimpleNamespace(id="t1", name="Pricing", summary="How plans are priced", doc_ids={"pricing-post"}, ideas=[]),
        SimpleNamespace(id="t2", name="Audience growth", summary="Subscriber expansion", doc_ids={"growth-post"}, ideas=[]),
    ]
    report_visuals.assign_themes([candidate], themes)
    assert candidate["theme_ids"] == ["t2"]
    assert "themes=t2" in report_visuals.opportunity_lines([candidate])[0]
    sections = [
        {"heading": "Subscriber growth", "brief": "Audience", "theme_ids": ["t1"]},
        {"heading": "Results", "brief": "Measured change", "theme_ids": ["t2"]},
    ]
    assert report_visuals.best_section(candidate, sections) == 1


def test_interactive_report_plans_and_writes_around_verified_data(monkeypatch):
    candidate = {"id": "v1", "block": {"type": "plot", "title": "Subscriber growth", "plot_kind": "line",
                                           "x_label": "Year", "y_label": "Subscribers", "points": [
        {"label": "2023", "value": 4100, "display_value": "4,100"},
        {"label": "2024", "value": 6200, "display_value": "6,200"},
    ]}}
    seen = {}

    def predict(sig, **kwargs):
        assert sig.__name__ == "PlanInteractiveReport"
        seen["plan"] = kwargs
        return {"report_title": "Audience report", "sections": [
            {"heading": "Introduction", "brief": "Set the context"},
            {"heading": "Subscriber growth", "brief": "Explain the audience increase", "data_candidate_id": "v1"},
            {"heading": "Summary", "brief": "Close the report"},
        ]}

    def predict_many(sig, inputs, **_kwargs):
        assert sig.__name__ == "WriteReportSection"
        seen["sections"] = inputs
        return [{"markdown": f"Text for {item['heading']}"} for item in inputs]

    monkeypatch.setattr(report.run, "predict", predict)
    monkeypatch.setattr(report.run, "predict_many", predict_many)
    monkeypatch.setattr(report, "update_job", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(report, "report_lm", lambda: None)
    material = SimpleNamespace(title="Posts", text=["numbered source"], is_chat=False)
    made = report.write_interactive(SimpleNamespace(), "workspace", SimpleNamespace(), material,
                                    "Explain audience growth", "English", [candidate])
    assert made is not None
    _, blocks, suggestions = made
    assert seen["plan"]["data_opportunities"][0].startswith("v1 | line plot | Subscriber growth")
    assert seen["sections"][1]["verified_data"][0].endswith("2023 = 4,100; 2024 = 6,200")
    plot = next(s for s in suggestions if s["kind"] == "plot")
    assert plot["after_block_id"] == blocks[1]["id"] and plot["candidate_id"] == "v1"
