// The task graph engine (docs/architecture/task-graph-engine.md): mechanism
// only — it stores the graph, enforces the lifecycle Shreni declares, and knows
// nothing about building software.
//
// Boundary: nothing in this directory imports from the rest of Shreni. Only Node
// built-ins and the libraries the spec adopts are allowed, enforced by
// boundary.test.ts.

export {};
