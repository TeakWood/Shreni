from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health() -> None:
    res = client.get("/health")
    assert res.status_code == 200
    assert res.json() == {"ok": True}


def test_list_items() -> None:
    res = client.get("/items")
    assert res.status_code == 200
    assert res.json()[0]["name"] == "first item"


def test_get_missing_item_is_404() -> None:
    assert client.get("/items/999").status_code == 404
