from pydantic import BaseModel, Field


class Item(BaseModel):
    id: int
    name: str = Field(min_length=1, max_length=80)


class ItemCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)
