// Go symbol walk: functions, receiver methods, and each name declared in a
// (possibly grouped) type/var/const block. A Go identifier is exported iff it
// begins with an uppercase letter.

import { type Node, nameText } from './common.js';

function isExported(name: string): boolean {
  return /^[A-Z]/.test(name);
}

export function walk(root: Node): string[] {
  const out: string[] = [];
  for (const child of root.namedChildren) {
    switch (child.type) {
      case 'function_declaration':
      case 'method_declaration': {
        const name = nameText(child);
        if (name && isExported(name)) out.push(name);
        break;
      }
      // `type (...)`, `var (...)`, `const (...)` group one spec per declared name.
      case 'type_declaration':
      case 'var_declaration':
      case 'const_declaration':
        for (const spec of child.namedChildren) {
          const name = nameText(spec);
          if (name && isExported(name)) out.push(name);
        }
        break;
    }
  }
  return out;
}
