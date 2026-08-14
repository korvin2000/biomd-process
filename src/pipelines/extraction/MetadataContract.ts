import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

import type { JsonObject } from '../../shared/json.js';

/**
 * The extraction output contract — the *shape* half of `docs/MetaData.md`.
 *
 * This module answers "is this a metadata document at all"; the rules that turn
 * a plausible answer into a conforming one — `DD.MM.YYYY` dates, comma-list
 * punctuation, uppercase document types, and the v2 rule that `id` / `title` /
 * `gender` / `type` / `country` / `bio` / `dataStatus` belong to `index.json`
 * and not here — live in {@link ./normalize.js}. The split is deliberate: a
 * schema violation is worth a retry, whereas an ISO date is worth a rewrite, and
 * conflating the two spends a round trip on something free to fix locally.
 *
 * Deliberately permissive on unknown keys: `passthrough()` keeps what the model
 * found rather than dropping it, which is the format guide's rule 12.
 *
 * The language-invariance of `dates`, `ranking` and `url` is not checked here
 * because it is not a property of one file: `localize` guarantees it structurally
 * by never sending those fields to a model at all.
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
