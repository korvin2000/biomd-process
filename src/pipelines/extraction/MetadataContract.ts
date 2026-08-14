import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

import type { JsonObject } from '../../shared/json.js';

/**
 * The extraction output contract.
 *
 * TODO(domain): this is a **thin placeholder** that mirrors `docs/MetaData.md`
 * closely enough to run end to end. Before production use it still needs:
 *   - the full field list and per-field descriptions from `docs/MetaData.md` §`metadata`;
 *   - `DD.MM.YYYY` date validation (and the "year only" variant the doc allows);
 *   - the rule that `dates`, `ranking` and `url` are language-invariant, which
 *     means cross-checking editions rather than validating one file;
 *   - rejection of the fields that moved to `index.json`
 *     (`id`, `title`, `gender`, `type`, `country`, `bio`, `dataStatus`);
 *   - normalization of comma-separated list fields.
 *
 * Deliberately permissive for now: `passthrough()` keeps unknown keys instead of
 * dropping data the model found, which matches the "preserve unknown fields"
 * rule in the format guide.
 */

const mediaItem = z.object({
  label: z.string(),
  target: z.string(),
});

const documentItem = z.object({
  label: z.string(),
  type: z.string().optional(),
  target: z.string(),
});

const dates = z
  .object({
    born: z.string().optional(),
    died: z.string().optional(),
    activeFrom: z.string().optional(),
    activeTo: z.string().optional(),
  })
  .partial();

export const metadataSchema = z
  .object({
    metadata: z
      .object({
        forename: z.string().optional(),
        surname: z.string().optional(),
        birthname: z.string().optional(),
        birthplace: z.string().optional(),
        deathplace: z.string().optional(),
        dates: dates.optional(),
        relatives: z.string().optional(),
        instruments: z.string().optional(),
        genres: z.string().optional(),
        bands: z.string().optional(),
        awards: z.string().optional(),
        teachers: z.string().optional(),
        disciples: z.string().optional(),
        jobs: z.string().optional(),
        ranking: z.number().min(0).max(100).optional(),
        url: z.string().optional(),
      })
      .passthrough()
      .default({}),
    media: z
      .object({
        photos: z.array(mediaItem).default([]),
        music: z.array(mediaItem).default([]),
      })
      .default({}),
    documents: z.array(documentItem).default([]),
  })
  .passthrough();

export type MetadataDocument = z.infer<typeof metadataSchema>;

/** JSON Schema for `response_format`, on models that support structured output. */
export const metadataJsonSchema: JsonObject = zodToJsonSchema(metadataSchema, {
  name: 'BioMetadata',
  $refStrategy: 'none',
}) as JsonObject;

export const METADATA_SCHEMA_NAME = 'BioMetadata';

/** Empty but structurally valid — the "nothing found" result. */
export function emptyMetadata(): MetadataDocument {
  return { metadata: {}, media: { photos: [], music: [] }, documents: [] };
}
