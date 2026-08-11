"""Children: the one piece of reference data the user maintains by hand.

Deletion is soft. A child's nights, notes and clips are the whole point of the
product, and a stray tap on a phone should not be able to destroy two years of
them; ``DELETE`` sets ``active = 0`` and the rows stay exactly where they were.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Query

from ...timeutil import now_ms
from ..deps import IdempotencyKey, ReposDep
from ..errors import Conflict, NotFound
from ..schemas import ChildCreate, ChildOut, ChildUpdate

router = APIRouter(prefix="/children", tags=["children"])


@router.get("", response_model=dict)
def list_children(
    repos: ReposDep,
    include_inactive: Annotated[bool, Query()] = False,
) -> dict[str, Any]:
    ts = now_ms()
    children = repos.children.list(include_inactive=include_inactive)
    items = [ChildOut.from_model(c, now_ms=ts) for c in children]
    return {"items": items, "total": len(items), "limit": len(items), "offset": 0}


@router.post("", response_model=ChildOut, status_code=201)
def create_child(
    payload: ChildCreate,
    repos: ReposDep,
    idempotency_key: IdempotencyKey = None,
) -> ChildOut:
    if repos.children.get_by_name(payload.name) is not None:
        raise Conflict(
            f"There is already a child called {payload.name!r}.",
            code="duplicate_name",
            detail={"name": payload.name},
        )
    child = repos.children.create(**payload.model_dump())
    return ChildOut.from_model(child, now_ms=now_ms())


@router.get("/{child_id}", response_model=ChildOut)
def get_child(child_id: int, repos: ReposDep) -> ChildOut:
    child = repos.children.get(child_id)
    if child is None:
        raise NotFound(f"No child with id {child_id}.", detail={"child_id": child_id})
    return ChildOut.from_model(child, now_ms=now_ms())


@router.patch("/{child_id}", response_model=ChildOut)
def update_child(
    child_id: int,
    payload: ChildUpdate,
    repos: ReposDep,
    idempotency_key: IdempotencyKey = None,
) -> ChildOut:
    if repos.children.get(child_id) is None:
        raise NotFound(f"No child with id {child_id}.", detail={"child_id": child_id})
    changes = payload.model_dump(exclude_unset=True)
    new_name = changes.get("name")
    if new_name:
        clash = repos.children.get_by_name(new_name)
        if clash is not None and clash.id != child_id:
            raise Conflict(
                f"There is already a child called {new_name!r}.", code="duplicate_name"
            )
    child = repos.children.update(child_id, **changes)
    assert child is not None
    return ChildOut.from_model(child, now_ms=now_ms())


@router.delete("/{child_id}", response_model=ChildOut)
def deactivate_child(
    child_id: int,
    repos: ReposDep,
    idempotency_key: IdempotencyKey = None,
) -> ChildOut:
    """Soft delete: the child stops appearing, their history stays."""
    if repos.children.get(child_id) is None:
        raise NotFound(f"No child with id {child_id}.", detail={"child_id": child_id})
    child = repos.children.update(child_id, active=False)
    assert child is not None
    return ChildOut.from_model(child, now_ms=now_ms())
