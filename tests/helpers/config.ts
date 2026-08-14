import type { AppConfigInput } from '../../src/config/schema.js';

/** Smallest config the schema accepts — everything else comes from defaults. */
export function minimalConfig(): AppConfigInput & {
  llm: { endpoints: Array<{ id: string; baseUrl: string }>; models: Array<{ id: string; endpoint: string; model: string }> };
} {
  return {
    llm: {
      endpoints: [{ id: 'local', baseUrl: 'http://localhost:4000/v1' }],
      models: [{ id: 'small', endpoint: 'local', model: 'test-model' }],
    },
  } as never;
}
