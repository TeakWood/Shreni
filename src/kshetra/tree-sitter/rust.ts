// Rust symbol walk: top-level `pub` items plus the public members of `impl`/`mod`
// blocks (where a type's public API usually lives — the line regex caught them by
// accident, this catches them by structure).

import { type Node, nameText, hasVisibilityModifier } from './common.js';

export function walk(root: Node): string[] {
  const out: string[] = [];
  const visit = (node: Node): void => {
    for (const child of node.namedChildren) {
      if (child.type === 'impl_item' || child.type === 'mod_item') {
        const body = child.childForFieldName('body');
        if (body) visit(body);
        continue;
      }
      if (hasVisibilityModifier(child)) {
        const name = nameText(child);
        if (name) out.push(name);
      }
    }
  };
  visit(root);
  return out;
}
