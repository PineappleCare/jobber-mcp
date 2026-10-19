import { z } from "zod";

// Quotes and jobs use positive quantities; invoice discount lines have a
// separate signed-quantity contract.
export const lineItemSchema = z.object({
  name: z.string().trim().min(1).max(250),
  description: z.string().trim().max(4000).optional(),
  quantity: z.number().positive().max(100000).default(1),
  unit_price: z.number().finite().min(0).max(1_000_000),
  taxable: z.boolean().optional(),
  product_or_service_id: z.string().trim().min(1).optional(),
});

export type JobLine = z.infer<typeof lineItemSchema>;
