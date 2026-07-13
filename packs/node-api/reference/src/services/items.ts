import { findAll, findById, insert, type Item } from '../repositories/items.js';

export function listItems(): Item[] {
  return findAll();
}

export function getItem(id: string): Item | undefined {
  return findById(id);
}

export function createItem(name: string): Item {
  return insert(name.trim());
}
