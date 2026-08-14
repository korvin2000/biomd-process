import type { LoadedConfig } from '../config/loader.js';
import type { AppConfig } from '../config/schema.js';
import type { ProjectPaths } from '../config/paths.js';
import { ContextStrategyRegistry } from '../documents/context/ContextStrategyRegistry.js';
import { Segmenter } from '../documents/Segmenter.js';
import { BudgetGuard } from '../llm/Budget.js';
import { LlmClientFactory } from '../llm/LlmClientFactory.js';
import { LlmGateway } from '../llm/LlmGateway.js';
import { ModelRegistry } from '../llm/ModelRegistry.js';
import { HeuristicTokenEstimator, type TokenEstimator } from '../llm/TokenEstimator.js';
import { FileArtifactWriter } from '../io/FileArtifactWriter.js';
import { FileSystemSource } from '../io/FileSystemSource.js';
import type { ArtifactWriter, SourceProvider } from '../io/types.js';
import { AppLogger, type Logger } from '../observability/Logger.js';
import { MetricsCollector } from '../observability/Metrics.js';
import { PromptRepository } from '../prompts/PromptRepository.js';
import { CircuitBreakerRegistry } from '../reliability/CircuitBreaker.js';
import { RateLimiterRegistry } from '../reliability/RateLimiter.js';
import { Router } from '../routing/Router.js';
import { RoutingStrategyRegistry } from '../routing/StrategyRegistry.js';
import { TargetStatsRegistry } from '../routing/TargetStats.js';
import { PipelineRegistry } from '../core/PipelineRegistry.js';
import { CatalogPipeline } from '../pipelines/catalog/CatalogPipeline.js';
import { ExtractionPipeline } from '../pipelines/extraction/ExtractionPipeline.js';
import { LocalizePipeline } from '../pipelines/localization/LocalizePipeline.js';
import { TranslationPipeline } from '../pipelines/translation/TranslationPipeline.js';
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
  /** Exposed so a host or a test can swap the transport for an endpoint. */
  clients: LlmClientFactory;
  gateway: LlmGateway;
  prompts: PromptRepository;
  contexts: ContextStrategyRegistry;
  segmenter: Segmenter;
  source: SourceProvider;
  writer: ArtifactWriter;
  pipelines: PipelineRegistry;
  metrics: MetricsCollector;
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
  const estimator = HeuristicTokenEstimator.fromConfig(config.context);
  const metrics = new MetricsCollector();
  const observers = new ObserverHub();

  const models = new ModelRegistry(config);
  const strategies = new RoutingStrategyRegistry();
  const stats = new TargetStatsRegistry();
  const router = new Router(
    strategies.get(config.llm.routing.strategy),
    stats,
    {
      reserveOutputTokens: config.context.reserveOutputTokens,
      safetyMarginRatio: config.context.safetyMarginRatio,
    },
    config.llm.routing.options,
  );

  const budget = new BudgetGuard(config.cost, (reason) => logger.warn(`Budget threshold reached: ${reason}`));
  const clients = new LlmClientFactory(config.llm.endpoints);
  const gateway = new LlmGateway(
    models,
    router,
    clients,
    new CircuitBreakerRegistry(config.reliability.circuitBreaker),
    new RateLimiterRegistry(),
    stats,
    budget,
    config.reliability,
    observers,
  );

  const segmenter = new Segmenter(estimator);
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
    clients,
    gateway,
    prompts: new PromptRepository(config.prompts, paths),
    contexts: new ContextStrategyRegistry(segmenter, config.context),
    segmenter,
    source: new FileSystemSource(config.input, paths, estimator),
    writer: new FileArtifactWriter(config.output, paths, dryRun),
    pipelines: new PipelineRegistry()
      .register(new ExtractionPipeline())
      .register(new TranslationPipeline())
      .register(new LocalizePipeline())
      .register(new CatalogPipeline()),
    metrics,
    budget,
    stats,
    observers,
  };

  options.configure?.(app);
  return app;
}
