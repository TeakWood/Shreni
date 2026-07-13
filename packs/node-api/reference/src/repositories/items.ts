export interface Item {
  id: string;
  name: string;
}

const items: Item[] = [{ id: '1', name: 'first item' }];

export function findAll(): Item[] {
  return [...items];
}

export function findById(id: string): Item | undefined {
  return items.find(i => i.id === id);
}

export function insert(name: string): Item {
  const item: Item = { id: String(items.length + 1), name };
  items.push(item);
  return item;
}
