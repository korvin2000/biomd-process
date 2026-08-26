# Source map

Where a thing lives, and what each file is the *only* place for. Read a row, open one
file — this exists so you never grep for a concept you could have looked up.

**Layout rule** (full statement: [ARCHITECTURE.md](../ARCHITECTURE.md) §2) — dependencies point
strictly inward; `src/domain` depends only on `shared`; `src/images` and `src/roster` depend only
on `domain` + `shared`; every collaborator is constructor-injected and wired in exactly one place,
`src/app/container.ts`.

```
cli → app → core ─┬→ pipelines → io
                  ├→ llm → routing + reliability
                  └→ documents · domain · images · roster · prompts · state
                                       └→ config → shared
```

## src/domain — the published format (no other layer may know these rules)

| File | Owns | Key exports |
|---|---|---|
| `types.ts` | `EntryRow`, `NameIndex`, `Dossier`, member orders, forbidden members, `DisplayNameOrder` | `FORBIDDEN_DOSSIER_MEMBERS` `METADATA_ORDER` `ROW_ORDER` `DATE_KEYS` `LIST_KEYS` `PROSE_KEYS` `DisplayNameOrder` |
| `values.ts` | every `VD-*` value domain | `normalizeDate` `parseDate` `datePrecisionOf` `refinesDate` `sharpensDate` `yearOf` `normalizeCsvList` `normalizeRanking` `normalizeUrl` `normalizeTarget` `slugOf` `normalizeId` `normalizeAssetPath` `normalizeContentPath` |
| `vocabulary.ts` | multilingual synonyms → canonical token | `resolveEntryType` `resolveGender` `resolveDocumentType` `resolveLanguage` `resolveEnsemble` `languageName` |
| `countries.ts` | 249 alpha-2 codes, both directions | `resolveCountry` `countryName` `isCountryCode` |
| `romanize.ts` | folding + Cyrillic transliteration | `foldToAscii` `romanizeCyrillic` `isLatinScript` `hasCyrillic` `toAscii` |
| `dossier.ts` | dossier lifecycle incl. v1→v2 migration | `sanitizeDossier` `mergeDossier` `orderDossier` `presentFields` `isEmptyDossier` |
| `catalog.ts` | `index.json` / `index-<lang>.json` load–upsert–merge | `CatalogIndex` `mergeNameIndex` `orderRow` `foldName` `splitLanguages` |
| `validate.ts` | the invariant checker behind `biomd validate` | `validateCatalogue` `Finding` `CatalogueSnapshot` |

## src/pipelines — the six tasks

| Dir | Entry point | Supporting files |
|---|---|---|
| `extraction/` | `ExtractionPipeline` | `FlatFields.ts` — the flat-card contract: `DEFAULT_FIELDS` `CATALOG_FIELDS` `PERSON_ONLY_FIELDS` `fieldsFor` `parseFlatAnswer` `normalizeFlat` `buildDossier` `answeredKeys` |
| `websearch/` | `WebSearchPipeline` `leadParagraph` | `gaps.ts` — `findGaps` `WEB_FIELDS` `ageOf` · `answer.ts` — `parseWebAnswer` `normalizePlace` `LivenessStatus` |
| `translation/` | `TranslationPipeline` | `StructureGuard.ts` — `StructureGuard` `StructureStrictness` |
| `localization/` | `LocalizePipeline` | `StringTable.ts` — `collectUnits` `applyUnits` `keyOf` `missingKeys` · `TranslationMemory.ts` · `TranslationMemoryRegistry.ts` |
| `portrait/` | `PortraitPipeline` `assetPath` | none — all logic lives in `src/images` |
| `catalog/` | `CatalogPipeline` | `names.ts` — `displayNamesOf` `latinTitleOf` `AliasPolicy`, and a re-export of `DisplayNameOrder` (which lives in `domain/types.ts`, because `validate` holds the same opinion for `INV-15`) |
| `shared/` | cross-pipeline helpers | `escalation.ts` — `runWithEscalation` `EscalationSpec` · `stringBatch.ts` — `translateUnits` (repair + narrowing ladders) · `dossierSource.ts` — `findSourceDossier` `findDossierToLocalize` `outputDossierPath` · `script.ts` — `isTranslatable` `hasOwnScript` `mixedScriptWords` `introducedMixedScriptWords` `untranslatedReason` · `roster.ts` — `rosterEntryFor` |

## src/documents — reading Markdown and putting it back

| File | Owns | Key exports |
|---|---|---|
| `markdown/textSpans.ts` | what is sent to a model and how it is re-spliced | `extractTextSpans` `applyTextSpans` `maskTokens` `missingMasks` `displacedMasks` `structuralDrift` `escapeBlockMarker` |
| `markdown/inline.ts` | **the one definition of a link/image pattern** — never re-derive it | `LINK_PATTERN` `IMAGE_PATTERN` `LINK_TARGET_PATTERN` `LABELLED_PATTERN` |
| `markdown/skeleton.ts` | structural equality of source vs translation | `markdownSkeleton` `compareSkeletons` `blockTokenOf` |
| `markdown/fences.ts` | code-vs-verse classification of a fenced block | `classifyFence` |
| `markdown/media.ts` | gallery + `imageTargets`, harvested for zero tokens | `harvestMedia` `HarvestResult` |
| `markdown/blocks.ts` · `title.ts` | block splitting · `readTitle` | `splitBlocks` `readTitle` |
| `context/strategies.ts` | the escalation ladder | `fullStrategy` `truncationFirstStrategy` `chunkedStrategy` `stagedStrategy` |
| `Segmenter.ts` | chunking | `Segmenter` `ChunkOptions` |

## src/images — the portrait matcher (LLM-free)

| File | Owns | Key exports |
|---|---|---|
| `select.ts` | the staged pipeline + the lexicographic key | `selectPortrait` `Selection` `Candidate` |
| `identity.ts` | *is this the right person* — one weight table | `IDENTITY` `scoreIdentity` `articleImageRank` |
| `suitability.ts` | *is this picture usable* — tiers, hybrid score | `scoreSuitability` `CLASS_RANK` `tierOf` `faceRank` |
| `subject.ts` | *how many people* — solo vs collective of n | `detectSubject` `expectedFaces` `faceFit` `SOLO_SUBJECT` |
| `query.ts` | slug + dossier + title → search terms | `buildQuery` `NameQuery` |
| `tokens.ts` | path → tokens, markers, initials, noise lexicon | `analysePath` `splitTokens` `phoneticKey` `isNoise` `isParticle` |
| `similarity.ts` | bounded OSA distance, length-dependent threshold | `editDistance` `similarity` `fuzzyThreshold` |
| `ImageIndexStore.ts` | one cached load, inverted maps, the junk guard on `meta` | `ImageIndexStore` `buildIndex` |

## src/llm + routing + reliability — the call path

| File | Owns | Key exports |
|---|---|---|
| `llm/LlmGateway.ts` | budget → route → breaker → limiter → retry → classify | `LlmGateway` `LlmPort` `GatewayObserver` `AttemptTuning` `AttemptRecord` `ValidationVerdict` |
| `llm/OpenAiCompatibleClient.ts` | Chat Completions + Responses transport, hosted-search evidence and cache usage mapping | `OpenAiCompatibleClient` `buildRequestBody` `buildResponsesRequestBody` `collectStream` `collectResponsesStream` |
| `llm/Lanes.ts` | a pool's share of an endpoint's concurrency | `LaneRegistry` |
| `llm/types.ts` | wire types + capability test | `ModelTarget` `CompletionRequest` `hasCapabilities` `usableInputTokens` |
| `llm/Budget.ts` · `CostCalculator.ts` · `ModelRegistry.ts` · `TokenEstimator.ts` | spend guard · pricing · target resolution · token estimate | `BudgetGuard` `estimateCost` `ModelRegistry` `HeuristicTokenEstimator` |
| `routing/Router.ts` | ranking, **both** fit windows, overflow policy | `Router` `OverflowPolicy` |
| `routing/strategies/builtin.ts` | the six strategies | `costOptimized` `contextOptimized` `sequential` `roundRobin` `leastFailures` `leastBusy` `defineStrategy` |
| `routing/types.ts` | what a strategy is allowed to see | `RoutingContext` `RoutingRequest` `OccupancyView` `fittingFirst` `slackOf` |
| `reliability/errors.ts` | **the error→disposition table. Extend it; never match provider message strings at a call site** | `LlmErrorKind` `Disposition` `dispositionOf` `isOutputTruncated` `AllTargetsFailedError` |
| `reliability/` rest | classification, breaker, limiter, retry | `ErrorClassifier` `CircuitBreakerRegistry` `RateLimiterRegistry` `RetryPolicy` |

## core · app · state · io · config · observability · roster · prompts

| File | Owns | Key exports |
|---|---|---|
| `core/types.ts` | the whole task vocabulary | `WorkItem` `TaskSeed` `PlannedTask` `TaskDependency` `TaskResult` `ExecutionContext` `DocumentPipeline` `CorpusPipeline` `isCorpusPipeline` |
| `core/JobPlanner.ts` | discovery → tasks → dependency resolution → skip decisions | `JobPlanner` `JobPlan` `SkipReason` |
| `core/Orchestrator.ts` | dependency waves, retirement, task-level fallback | `Orchestrator` `RunSummary` `TaskFailure` |
| `core/AttemptScope.ts` | carries attempt tuning into every call a task makes | `AttemptScope` |
| `app/container.ts` | **the only place concrete implementations are wired**; `createApp(loaded, { configure: app => … })` is the real extension point | `createApp` `App` `CreateAppOptions` |
| `app/runJob.ts` | plan + execute + summarize | `runJob` `planJob` |
| `state/Fingerprint.ts` | the two ids | `taskIdOf` `fingerprintOf` |
| `state/types.ts` | journal + checkpoint shapes; the **`isTaskDone` whitelist** | `TaskStatus` `RunManifest` `JournalRecord` `isTaskDone` |
| `state/RunStore.ts` | `.biomd/runs/<id>/` read + append | `RunStore` `newRunId` |
| `io/` | source discovery, atomic writes, path templates, catalogue read-back | `FileSystemSource` `FileArtifactWriter` `renderPathTemplate` `readCatalogue` |
| `config/schema.ts` | **1413 lines of Zod — the authority on every setting and default** | `appConfigSchema` `AppConfig` + one exported type per section |
| `config/loader.ts` | layered load, issue formatting, redaction | `loadConfig` `redactConfig` `formatIssues` |
| `observability/ProgressLog.ts` | the `tail -f`-able line per finished task | `ProgressLog` |
| `observability/Logger.ts` | JSONL app log; **envelope written last** | `AppLogger` `nullLogger` |
| `roster/` | `data/names.json`: format, load, and the two judgement calls | `NameRosterStore` `toRosterEntry` `isNamePart` `RosterEntry` |
| `prompts/MessageBuilder.ts` | **the cache-friendly message order** | `MessageBuilder` `PromptSection` |
| `prompts/PromptRepository.ts` | template load, per-model overrides, `promptVersion` hashing | `versionOf` `variantsOf` `render(task, vars, modelId?)` |
| `prompts/PromptBundle.ts` | one task's prompt rendered for every model that could answer it | `buildPromptBundle` `PromptBundle` |
| `shared/` | errors, hashing, atomic fs, safe JSON, timeouts | `AppError` `ConfigError` `PipelineError` `sha` `hashStructure` `writeFileAtomic` `safeJsonParse` `extractJsonBlock` `withTimeout` |

## tests

| File | Covers |
|---|---|
| `helpers/workspace.ts` | `Workspace` — temp dir + `createApp` + `FakeClient`. **Read this before writing any test** |
| `run.e2e.test.ts` · `scheduling.e2e.test.ts` · `websearch.e2e.test.ts` · `roster.e2e.test.ts` | whole job runs against the fake transport |
| `domain.test.ts` · `validate.test.ts` · `catalog.test.ts` | the format layer |
| `documents.test.ts` · `segmentation.test.ts` · `media.test.ts` | Markdown in and out |
| `routing.test.ts` · `providerrouting.test.ts` · `lanes.test.ts` · `reliability.test.ts` · `ratelimiter.test.ts` · `taskfallback.test.ts` | the call path |
| `extraction.test.ts` · `repair.test.ts` · `websearch.test.ts` · `portrait.test.ts` · `roster.test.ts` | pipeline behaviour |
| `scriptgate.test.ts` · `modelprompts.test.ts` | an answer that was not translated · a template for one model |
| `adaptive.test.ts` · `adaptive.simulation.test.ts` | the `adaptive` strategy, and a whole corpus through it against a fake provider |
| `config.test.ts` · `io-and-prompts.test.ts` · `progresslog.test.ts` · `streaming.test.ts` | edges |

## Non-source inputs, read but never written

| Path | What | Described by |
|---|---|---|
| `external/` | the normative format spec, 9 docs, version 2 | [external/README.md](../../external/README.md) |
| `images/artists.json` | ~2000 photographs | [images/image-index-spec.md](../../images/image-index-spec.md) |
| `data/names.json` | 739 name records against ~1000 articles | `src/roster/types.ts` (no separate spec) |
