export type { OccupancyView, RoutingStrategy, RoutingContext, RoutingRequest, TargetStats } from './types.js';
export { emptyStats, fittingFirst } from './types.js';
export { RoutingStrategyRegistry } from './StrategyRegistry.js';
export { TargetStatsRegistry } from './TargetStats.js';
export { Router } from './Router.js';
export type { RouterFittingOptions } from './Router.js';
export {
  builtinStrategies,
  costOptimized,
  contextOptimized,
  sequential,
  roundRobin,
  leastFailures,
  leastBusy,
  defineStrategy,
} from './strategies/builtin.js';
