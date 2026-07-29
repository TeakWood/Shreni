// Shared AST helpers for the per-language tree-sitter walkers (Shreni-beads-l40).
// Kept in one place so `python.ts` / `go.ts` / `rust.ts` / `java.ts` stay focused
// on their language's node shapes. Type-only import of web-tree-sitter — no
// runtime dependency lives here.

import type Parser from 'web-tree-sitter';

export type Node = Parser.SyntaxNode;

// A declaration's bound name: the `name` field where the grammar exposes one
// (python/go/rust/java all do), else the first identifier child as a fallback.
export function nameText(node: Node): string | null {
  const field = node.childForFieldName('name');
  if (field) return field.text;
  for (const c of node.namedChildren) {
    if (c.type === 'identifier' || c.type === 'type_identifier') return c.text;
  }
  return null;
}

// True when a node carries a `visibility_modifier` child (Rust's `pub`, incl.
// `pub(crate)` — matched broadly, as the prior regex did).
export function hasVisibilityModifier(node: Node): boolean {
  return node.namedChildren.some(c => c.type === 'visibility_modifier');
}

// The text of a node's `modifiers` child (Java), or '' when absent.
export function modifiersText(node: Node): string {
  const mods = node.namedChildren.find(c => c.type === 'modifiers');
  return mods ? mods.text : '';
}
