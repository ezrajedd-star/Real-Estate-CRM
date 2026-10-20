import { type PipeTransform } from '@nestjs/common';
import type { ZodTypeAny, z } from 'zod';
import { BadRequest, NotFound } from './errors.js';

/**
 * Schema validation for every request body / query (brief §8.2). Unknown keys are stripped
 * (Zod's default), and errors report paths and messages only — never the submitted values.
 */
export class ZodPipe<S extends ZodTypeAny> implements PipeTransform<unknown, z.infer<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.infer<S> {
    const result = this.schema.safeParse(value ?? {});
    if (!result.success) {
      throw BadRequest(
        'VALIDATION_FAILED',
        'Some fields are invalid',
        result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }
    return result.data;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Route ids must be UUIDs; anything else is a 404, not a 400, so ids cannot be probed. */
export class UuidPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!UUID_RE.test(value)) throw NotFound();
    return value.toLowerCase();
  }
}
