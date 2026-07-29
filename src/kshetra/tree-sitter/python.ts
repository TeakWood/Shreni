// Python symbol walk: top-level defs/classes, unwrapping decorators. Leading
// underscore is Python's private convention and is skipped.

import { type Node, nameText } from './common.js';

export function walk(root: Node): string[] {
  const out: string[] = [];
  for (const child of root.namedChildren) {
    // `@decorator`-wrapped defs sit under decorated_definition.definition.
    const def = child.type === 'decorated_definition' ? child.childForFieldName('definition') : child;
    if (!def) continue;
    if (def.type === 'function_definition' || def.type === 'class_definition') {
      const name = nameText(def);
      if (name && !name.startsWith('_')) out.push(name);
    }
  }
  return out;
}
