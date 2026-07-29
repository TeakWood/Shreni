// TS/JS/TSX symbol walk: top-level EXPORTED declarations. Parsed with the `tsx`
// grammar, a superset that reads TypeScript, plain JS, and JSX — so one grammar
// covers every .ts/.tsx/.js/.jsx/.mts/.cts/.mjs/.cjs file.
//
// Covers the cases a line regex mishandles: multi-line `export { … as … }` lists,
// destructuring binding exports, default exports (named and anonymous), and
// `export *` re-exports — matching what the old TypeScript-compiler path emitted.

import { type Node } from './common.js';

// Named-declaration node types that expose a `name` field.
const NAMED_DECLARATIONS = new Set([
  'function_declaration', 'generator_function_declaration',
  'class_declaration', 'abstract_class_declaration',
  'interface_declaration', 'enum_declaration', 'type_alias_declaration',
  'internal_module', 'module', // `namespace X {}` / `module X {}`
]);

// Anonymous default-export values → listed as "default".
const ANONYMOUS_VALUES = new Set([
  'function_expression', 'generator_function_expression', 'class', 'arrow_function',
]);

// Collect the identifier names bound by a (possibly destructuring) declarator
// target: `export const { a, b } = …` / `export const [x] = …`.
function collectBinding(node: Node, out: string[]): void {
  switch (node.type) {
    case 'identifier':
    case 'shorthand_property_identifier_pattern':
      out.push(node.text);
      break;
    case 'object_pattern':
    case 'array_pattern':
    case 'rest_pattern':
    case 'assignment_pattern':
      for (const el of node.namedChildren) collectBinding(el, out);
      break;
    case 'pair_pattern': {
      const value = node.childForFieldName('value');
      if (value) collectBinding(value, out);
      break;
    }
  }
}

function collectExport(stmt: Node, out: string[]): void {
  let matched = false;
  for (const child of stmt.namedChildren) {
    if (NAMED_DECLARATIONS.has(child.type)) {
      const name = child.childForFieldName('name');
      out.push(name ? name.text : 'default'); // `export default function X` vs anon
      matched = true;
    } else if (child.type === 'lexical_declaration' || child.type === 'variable_declaration') {
      for (const decl of child.namedChildren) {
        if (decl.type === 'variable_declarator') {
          const target = decl.childForFieldName('name');
          if (target) collectBinding(target, out);
        }
      }
      matched = true;
    } else if (child.type === 'export_clause') {
      // `export { a, b as c }` — the exported name is the alias when present,
      // which is the last identifier in each specifier.
      for (const spec of child.namedChildren) {
        if (spec.type !== 'export_specifier') continue;
        const ids = spec.namedChildren.filter(c => c.type === 'identifier');
        const exported = ids[ids.length - 1];
        if (exported) out.push(exported.text);
      }
      matched = true;
    } else if (child.type === 'namespace_export') {
      // `export * as ns from '…'`
      const id = child.namedChildren.find(c => c.type === 'identifier');
      if (id) out.push(id.text);
      matched = true;
    } else if (ANONYMOUS_VALUES.has(child.type)) {
      out.push('default');
      matched = true;
    }
  }
  if (!matched) {
    // Either `export * from '…'` (bare re-export, a string child and nothing
    // named) or `export default <expr>` / `export = <expr>`.
    if (stmt.namedChildren.some(c => c.type === 'string')) out.push('* (re-export)');
    else out.push('default');
  }
}

export function walk(root: Node): string[] {
  const out: string[] = [];
  for (const stmt of root.namedChildren) {
    if (stmt.type === 'export_statement') collectExport(stmt, out);
  }
  return out;
}
