// Kysely 0.29 exports its migrator only from the `kysely/migration` subpath,
// which tsconfig's node10 resolution can't see (it ignores package exports).
// Node and esbuild resolve the subpath at runtime; this gives tsc its types.
declare module 'kysely/migration' {
  export * from 'kysely/dist/migration/index';
}
