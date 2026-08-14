export { ExtractionPipeline } from './extraction/ExtractionPipeline.js';
export {
  metadataSchema,
  metadataJsonSchema,
  emptyMetadata,
  METADATA_SCHEMA_NAME,
} from './extraction/MetadataContract.js';
export type { MetadataDocument } from './extraction/MetadataContract.js';
export { mergeMetadata, hasField } from './extraction/merge.js';

export { TranslationPipeline } from './translation/TranslationPipeline.js';
export { StructureGuard } from './translation/StructureGuard.js';
export type { StructureVerdict } from './translation/StructureGuard.js';

export { LocalizePipeline } from './localization/LocalizePipeline.js';
export { collectUnits, applyUnits, missingKeys, keyOf } from './localization/StringTable.js';
export type { LocalizationOptions, LocalizationUnit } from './localization/StringTable.js';
export { TranslationMemory } from './localization/TranslationMemory.js';
export type { MemoryStats } from './localization/TranslationMemory.js';

export { CatalogPipeline } from './catalog/CatalogPipeline.js';
export { IdAllocator } from './catalog/IdAllocator.js';
export type { CatalogRow } from './catalog/IdAllocator.js';
export { displayNamesOf, latinTitleOf } from './catalog/names.js';
export type { DossierNames } from './catalog/names.js';

export { runWithEscalation } from './shared/escalation.js';
export type { EscalationSpec, EscalationResult, Parsed } from './shared/escalation.js';
export { translateUnits } from './shared/stringBatch.js';
export type { StringBatchSpec, StringBatchResult } from './shared/stringBatch.js';
