import pytest

from app.llm import run
from app.pipeline import study_batches
from app.pipeline.study_batches import predict_in_halves


def _go(monkeypatch, predict, many, count, material):
    monkeypatch.setattr(run, "predict", predict)
    monkeypatch.setattr(run, "predict_many", many)
    return predict_in_halves(object, db=None, workspace_id=None, job=None, lm=None, material=material, count=count,
                             inputs={"topic": "t"}, key="cards")


def test_a_small_set_is_one_call(monkeypatch):
    out = _go(monkeypatch, lambda *a, **k: {"cards": ["a"]}, lambda *a, **k: pytest.fail("two calls"), 5, ["note", "x", "y", "z"])
    assert out == ["a"]


def test_a_set_of_six_or_more_is_two_halves_with_their_own_material(monkeypatch):
    seen = []

    def many(sig, inputs_list, **kw):
        seen.extend(inputs_list)
        return [{"cards": [f"c{i['count']}"]} for i in inputs_list]

    out = _go(monkeypatch, lambda *a, **k: pytest.fail("one call"), many, 9, ["note", "1", "2", "3", "4"])
    assert [i["count"] for i in seen] == [6, 5] and out == ["c6", "c5"]
    assert seen[0]["material"] == ["note", "1", "3"] and seen[1]["material"] == ["note", "2", "4"] and seen[0]["topic"] == "t"


def test_one_failed_half_costs_only_its_share_and_two_failed_halves_fall_back_to_one_call(monkeypatch):
    out = _go(monkeypatch, lambda *a, **k: pytest.fail("one call"), lambda s, i, **k: [None, {"cards": ["b"]}], 8, ["n", "1", "2"])
    assert out == ["b"]
    out = _go(monkeypatch, lambda *a, **k: {"cards": ["whole"]}, lambda s, i, **k: [None, None], 8, ["n", "1", "2"])
    assert out == ["whole"]


def test_only_rate_limits_are_retried(monkeypatch):
    monkeypatch.setattr(run.time, "sleep", lambda s: None)
    tries = []

    def limited():
        tries.append(1)
        if len(tries) < 3:
            raise RuntimeError("Error code: 429 - {'code': '1305'}")
        return "ok"

    assert run._call(limited) == "ok" and len(tries) == 3
    quota = []

    def over():
        quota.append(1)
        raise RuntimeError("Error code: 429 - {'code': '1310'} weekly quota")

    with pytest.raises(RuntimeError):
        run._call(over)
    assert len(quota) == 1  # a quota does not clear by retrying
    with pytest.raises(ValueError):
        run._call(lambda: (_ for _ in ()).throw(ValueError("bad input")))
