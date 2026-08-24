import type { LoadedConfig } from '../config/loader.js';
import type { AppConfig } from '../config/schema.js';
import type { ProjectPaths } from '../config/paths.js';
import { ContextStrategyRegistry } from '../documents/context/ContextStrategyRegistry.js';
import { Segmenter } from '../documents/Segmenter.js';
import { BudgetGuard } from '../llm/Budget.js';
import { LaneRegistry } from '../llm/Lanes.js';
import { LlmClientFactory } from '../llm/LlmClientFactory.js';
import { LlmGateway } from '../llm/LlmGateway.js';
import { ModelRegistry } from '../llm/ModelRegistry.js';
import { HeuristicTokenEstimator, type TokenEstimator } from '../llm/TokenEstimator.js';
import { FileArtifactWriter } from '../io/FileArtifactWriter.js';
import { FileSystemSource } from '../io/FileSystemSource.js';
import type { ArtifactWriter, SourceProvider } from '../io/types.js';
import { AppLogger, type Logger } from '../observability/Logger.js';
import { MetricsCollector } from '../observability/Metrics.js';
import { ProgressLog } from '../observability/ProgressLog.js';
import { PromptRepository } from '../prompts/PromptRepository.js';
import { CircuitBreakerRegistry } from '../reliability/CircuitBreaker.js';
import { RateLimiterRegistry } from '../reliability/RateLimiter.js';
import { Router } from '../routing/Router.js';
import { RoutingStrategyRegistry } from '../routing/StrategyRegistry.js';
import { TargetStatsRegistry } from '../routing/TargetStats.js';
import { PipelineRegistry } from '../core/PipelineRegistry.js';
import { ImageIndexStore } from '../images/ImageIndexStore.js';
import { NameRosterStore } from '../roster/NameRosterStore.js';
import { CatalogPipeline } from '../pipelines/catalog/CatalogPipeline.js';
import { ExtractionPipeline } from '../pipelines/extraction/ExtractionPipeline.js';
import { LocalizePipeline } from '../pipelines/localization/LocalizePipeline.js';
import { PortraitPipeline } from '../pipelines/portrait/PortraitPipeline.js';
import { TranslationMemoryRegistry } from '../pipelines/localization/TranslationMemoryRegistry.js';
import { TranslationPipeline } from '../pipelines/translation/TranslationPipeline.js';
import { WebSearchPipeline } from '../pipelines/websearch/WebSearchPipeline.js';
import { ObserverHub } from './ObserverHub.js';

export interface App {
  config: AppConfig;
  configFile: string;
  configHash: string;
  paths: ProjectPaths;
  logger: Logger;
  estimator: TokenEstimator;
  models: ModelRegistry;
  strategies: RoutingStrategyRegistry;
  router: Router;
  /** Endpoint concurrency: who is busy, and how a pool's share of it is capped. */
  lanes: LaneRegistry;
  /** Exposed so a host or a test can swap the transport for an endpoint. */
  clients: LlmClientFactory;
  gateway: LlmGateway;
  prompts: PromptRepository;
  contexts: ContextStrategyRegistry;
  segmenter: Segmenter;
  source: SourceProvider;
  writer: ArtifactWriter;
  /** The image index behind portrait selection; cached for the whole run. */
  images: ImageIndexStore;
  /** The name roster — a second opinion on names; cached for the whole run. */
  roster: NameRosterStore;
  memories: TranslationMemoryRegistry;
  pipelines: PipelineRegistry;
  metrics: MetricsCollector;
  /** The plain-text account of the run, for a person watching it happen. */
  progressLog: ProgressLog;
  budget: BudgetGuard;
  stats: TargetStatsRegistry;
  observers: ObserverHub;
}

export interface CreateAppOptions {
  /** Resolve paths and plan everything, but write nothing. */
  dryRun?: boolean;
  /** Extension hook: register custom pipelines, strategies or transports. */
  configure?: (app: App) => void;
}

/**
 * The composition root — the one place that knows how the parts fit together.
 *
 * Every module above takes its collaborators as constructor arguments and none
 * of them constructs another, which is what keeps them independently testable
 * and lets a host application swap any single piece.
 */
export function createApp(loaded: LoadedConfig, options: CreateAppOptions = {}): App {
  const { config, paths } = loaded;
  const dryRun = options.dryRun ?? config.run.dryRun;

  const logger = AppLogger.create(config.logging, (file) => paths.resolve(file));
  // Silent under --dry-run: nothing was processed, so a log of what processed
  // it would be fiction.
  const progressLog = new ProgressLog({
    file: config.logging.progressFile && !dryRun ? paths.resolve(config.logging.progressFile) : null,
    intervalMs: config.logging.progressIntervalMs,
  });
  const estimator = HeuristicTokenEstimator.fromConfig(config.context);
  const metrics = new MetricsCollector();
  const observers = new ObserverHub();

  const models = new ModelRegistry(config);
  const strategies = new RoutingStrategyRegistry();
  const stats = new TargetStatsRegistry();
  // One object answers "who is busy" for both halves of the decision: the
  // strategy reads it to rank, the gateway claims against it to make the
  // ranking real. Two would drift.
  const lanes = new LaneRegistry(config.llm.routing, config.llm.endpoints, new RateLimiterRegistry());
  const router = new Router(
    strategies,
    config.llm.routing,
    stats,
    {
      reserveOutputTokens: config.context.reserveOutputTokens,
      safetyMarginRatio: config.context.safetyMarginRatio,
      onOverflow: config.llm.routing.onOverflow,
    },
    lanes,
  );
  // The one strategy id the Router cannot check for itself, because it lives
  // under `reliability` rather than `llm.routing`. Same rule as every other:
  // a name that does not resolve is a config error, and the honest time to say
  // so is now — not on the one task unlucky enough to reach its last attempt.
  const lastAttemptStrategy = config.reliability.taskFallback.lastAttempt.strategy;
  if (lastAttemptStrategy) strategies.get(lastAttemptStrategy);

  const budget = new BudgetGuard(config.cost, (reason) => logger.warn(`Budget threshold reached: ${reason}`));
  const clients = new LlmClientFactory(config.llm.endpoints);
  const gateway = new LlmGateway(
    models,
    router,
    clients,
    new CircuitBreakerRegistry(config.reliability.circuitBreaker),
    lanes,
    stats,
    budget,
    config.reliability,
    observers,
  );

  const segmenter = new Segmenter(estimator);
  const images = new ImageIndexStore(paths);
  const roster = new NameRosterStore(paths);
  const app: App = {
    config,
    configFile: loaded.file,
    configHash: loaded.hash,
    paths,
    logger,
    estimator,
    models,
    strategies,
    router,
    lanes,
    clients,
    gateway,
    prompts: new PromptRepository(config.prompts, paths),
    contexts: new ContextStrategyRegistry(segmenter, config.context),
    segmenter,
    source: new FileSystemSource(config.input, paths, estimator),
    writer: new FileArtifactWriter(config.output, paths, dryRun),
    images,
    roster,
    memories: new TranslationMemoryRegistry(paths.resolve(config.run.memoryDir), logger, dryRun),
    pipelines: new PipelineRegistry()
      .register(new ExtractionPipeline(roster))
      .register(new WebSearchPipeline())
      .register(new TranslationPipeline())
      .register(new LocalizePipeline())
      .register(new PortraitPipeline(images, roster))
      .register(new CatalogPipeline(roster)),
    metrics,
    progressLog,
    budget,
    stats,
    observers,
  };

  options.configure?.(app);
  return app;
}
