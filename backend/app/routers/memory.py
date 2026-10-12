from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.auth import Ctx, get_ctx
from app.services import memory

router = APIRouter(prefix="/api/memory", tags=["memory"])


class FactIn(BaseModel):
    value: str = Field(min_length=1, max_length=memory.MAX_VALUE)


@router.get("")
def list_facts(ctx: Ctx = Depends(get_ctx)):
    return {"items": memory.list_facts(ctx.db, ctx.workspace.id), "limit": memory.MAX_FACTS}


@router.put("/{key}")
def put_fact(key: str, body: FactIn, ctx: Ctx = Depends(get_ctx)):
    return memory.set_fact(ctx.db, ctx.workspace.id, key, body.value)


@router.delete("/{key}")
def delete_fact(key: str, ctx: Ctx = Depends(get_ctx)):
    if not memory.delete_fact(ctx.db, ctx.workspace.id, key):
        raise HTTPException(404, "Note not found")
    return {"ok": True}
