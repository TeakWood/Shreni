import { describe, it, expect } from 'vitest';
import { buildApp } from './app.js';

describe('fastify-mini', () => {
  it('GET /health returns ok', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('GET /items returns the seed item', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/items' });
    expect(res.statusCode).toBe(200);
    expect(res.json()[0].name).toContain('first');
  });

  it('GET /items/:id returns 404 for a missing item', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/items/999' });
    expect(res.statusCode).toBe(404);
  });
});
