import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { listItems, getItem } from '../services/items.js';

const ItemParamsSchema = z.object({ id: z.string().min(1) });

export function itemRoutes(app: FastifyInstance): void {
  app.get('/items', async () => listItems());

  app.get('/items/:id', async (req, reply) => {
    const params = ItemParamsSchema.safeParse(req.params);
    if (!params.success) {
      return reply.status(400).send({ error: 'invalid id' });
    }
    const item = getItem(params.data.id);
    if (!item) {
      return reply.status(404).send({ error: 'not found' });
    }
    return item;
  });
}
