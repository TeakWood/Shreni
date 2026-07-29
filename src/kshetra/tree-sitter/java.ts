// Java symbol walk: top-level public type declarations (class/interface/enum/
// record/annotation). Visibility is read from the `modifiers` child.

import { type Node, nameText, modifiersText } from './common.js';

const PUBLIC_TYPES = new Set([
  'class_declaration', 'interface_declaration', 'enum_declaration',
  'record_declaration', 'annotation_type_declaration',
]);

export function walk(root: Node): string[] {
  const out: string[] = [];
  for (const child of root.namedChildren) {
    if (!PUBLIC_TYPES.has(child.type)) continue;
    if (!modifiersText(child).includes('public')) continue;
    const name = nameText(child);
    if (name) out.push(name);
  }
  return out;
}
