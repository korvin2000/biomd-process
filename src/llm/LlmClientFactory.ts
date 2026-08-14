import type { EndpointConfig } from '../config/schema.js';
import { ConfigError } from '../shared/errors.js';
import { OpenAiCompatibleClient } from './OpenAiCompatibleClient.js';
import type { LlmClient } from './types.js';

export type ClientBuilder = (endpoint: EndpointConfig) => LlmClient;

/**
 * One client per endpoint, created lazily and reused (each holds a connection
 * pool). Registering a builder is the extension point for a non-OpenAI
 * transport — a native Anthropic client, a provider batch API, a fake in tests.
 */
export class LlmClientFactory {
  private readonly clients = new Map<string, LlmClient>();
  private readonly builders = new Map<string, ClientBuilder>();
  private defaultBuilder: ClientBuilder = (endpoint) => new OpenAiCompatibleClient(endpoint);

  constructor(private readonly endpoints: readonly EndpointConfig[]) {}

  /** Override the transport for one endpoint id. */
  register(endpointId: string, builder: ClientBuilder): this {
    this.builders.set(endpointId, builder);
    this.clients.delete(endpointId);
    return this;
  }

  /** Override the transport used for every endpoint without a specific builder. */
  setDefaultBuilder(builder: ClientBuilder): this {
    this.defaultBuilder = builder;
    this.clients.clear();
    return this;
  }

  for(endpointId: string): LlmClient {
    let client = this.clients.get(endpointId);
    if (client) return client;

    const endpoint = this.endpoints.find((candidate) => candidate.id === endpointId);
    if (!endpoint) throw new ConfigError(`Unknown endpoint "${endpointId}"`);

    client = (this.builders.get(endpointId) ?? this.defaultBuilder)(endpoint);
    this.clients.set(endpointId, client);
    return client;
  }
}
