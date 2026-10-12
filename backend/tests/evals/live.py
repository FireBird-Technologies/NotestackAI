"""Shared helpers for the opt-in live evals (real model calls). conftest blanks every API key in the environment so
the normal tests never call out; these read them from the same .env files the app loads (backend first, then the
repo root)."""

from dotenv import dotenv_values

from app.config import _ROOT_ENV


def env_value(name: str) -> str:
    for path in (".env", _ROOT_ENV):
        value = dotenv_values(path).get(name)
        if value:
            return value
    return ""
