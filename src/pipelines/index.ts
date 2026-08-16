export { ExtractionPipeline } from './extraction/ExtractionPipeline.js';
export {
  DEFAULT_FIELDS,
  CATALOG_FIELDS,
  OPTIONAL_FIELDS,
  fieldsFor,
  parseFlatAnswer,
  normalizeFlat,
  mergeFlat,
  buildDossier,
  toCardKey,
} from './extraction/FlatFields.js';
export type { FlatField, FlatRecord } from './extraction/FlatFields.js';
export { findSourceDossier, findDossierToLocalize, sourceDossierPath, outputDossierPath } from './shared/dossierSource.js';
export type { ExistingDossier } from './shared/dossierSource.js';

export { TranslationPipeline } from './translation/TranslationPipeline.js';
export { StructureGuard } from './translation/StructureGuard.js';
export type { StructureVerdict } from './translation/StructureGuard.js';

export { LocalizePipeline } from './localization/LocalizePipeline.js';
export { collectUnits, applyUnits, missingKeys, keyOf } from './localization/StringTable.js';
export type { LocalizationOptions, LocalizationUnit } from './localization/StringTable.js';
export { TranslationMemory } from './localization/TranslationMemory.js';
export type { MemoryStats } from './localization/TranslationMemory.js';

export { CatalogPipeline } from './catalog/CatalogPipeline.js';
export { displayNamesOf, latinTitleOf } from './catalog/names.js';
export type { DossierNames } from './catalog/names.js';
export { foldToAscii, romanizeCyrillic, isLatinScript, toAscii } from '../domain/romanize.js';

export { runWithEscalation } from './shared/escalation.js';
export type { EscalationSpec, EscalationResult, Parsed } from './shared/escalation.js';
export { translateUnits } from './shared/stringBatch.js';
export type { StringBatchSpec, StringBatchResult } from './shared/stringBatch.js';
