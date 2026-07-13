# Architecture — Node API (fastify)

> Materialized from the `node-api` pack. Replace the placeholders with your
> project's real notes; keep the layer boundaries.

## Layout

```
src/
  app.ts             # buildApp(): registers plugins, routes, error handler
  routes/            # HTTP boundary — schema-validate, call a service
  services/          # business logic, framework-free
  repositories/      # data access — the only layer that touches the store
  config.ts          # env parsed once through a schema at startup
```

## Rules of the road

- A route never imports a repository; a service never imports fastify types.
- `buildApp()` is a pure factory (no `listen`) so tests can `app.inject()`
  without opening a port.
- One error handler turns thrown errors into responses; routes just throw.
- Keep the rubric framework-thin: fastify is the fixture's choice, but the
  layering above applies to express/koa the same way.
