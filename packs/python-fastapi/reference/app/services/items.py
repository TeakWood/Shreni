from app.models import Item, ItemCreate

_items: list[Item] = [Item(id=1, name="first item")]


def list_items() -> list[Item]:
    return list(_items)


def get_item(item_id: int) -> Item | None:
    return next((i for i in _items if i.id == item_id), None)


def create_item(payload: ItemCreate) -> Item:
    item = Item(id=len(_items) + 1, name=payload.name)
    _items.append(item)
    return item
