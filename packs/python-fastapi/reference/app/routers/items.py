from fastapi import APIRouter, HTTPException

from app.models import Item
from app.services.items import get_item, list_items

router = APIRouter()


@router.get("/items")
async def read_items() -> list[Item]:
    return list_items()


@router.get("/items/{item_id}")
async def read_item(item_id: int) -> Item:
    item = get_item(item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="not found")
    return item
