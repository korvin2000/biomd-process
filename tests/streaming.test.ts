import { describe, expect, it } from 'vitest';

import {
  collectResponsesStream,
  collectStream,
  mapChatUsage,
  mapResponsesUsage,
} from '../src/llm/OpenAiCompatibleClient.js';

/**
 * Reassembling a streamed completion.
 *
 * Streaming is a transport detail everywhere except against a gateway whose
 * buffered path is broken — `omniroute` answers the *second* of two overlapping
 * `stream: false` requests with the first one's completion — so the collector
 * has to produce exactly what the non-streamed path would, usage included, or
 * turning it on quietly costs the run its token counts and its budget guard.
 */

async function* chunks<T>(...items: T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

describe('collectStream', () => {
  it('concatenates deltas and keeps finish reason, usage and model', async () => {
    const completion = await collectStream(
      chunks(
        { model: 'cx/gpt-5.6-luna', choices: [{ delta: { content: '{"a":' } }] },
        { choices: [{ delta: { content: '"one"}' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
        { usage: { prompt_tokens: 36, completion_tokens: 13, total_tokens: 49 } },
      ),
    );

    expect(completion.choices?.[0]?.message?.content).toBe('{"a":"one"}');
    expect(completion.choices?.[0]?.finish_reason).toBe('stop');
    expect(completion.usage?.total_tokens).toBe(49);
    expect(completion.model).toBe('cx/gpt-5.6-luna');
  });

  it('prefers deltas over a whole message, so nothing is counted twice', async () => {
    // Some gateways emit the accumulated message on the final chunk as well.
    const completion = await collectStream(
      chunks(
        { choices: [{ delta: { content: 'Hello ' } }] },
        { choices: [{ delta: { content: 'world' } }] },
        { choices: [{ message: { content: 'Hello world' }, finish_reason: 'stop' }] },
      ),
    );

    expect(completion.choices?.[0]?.message?.content).toBe('Hello world');
  });

  it('falls back to a whole message when no delta ever arrives', async () => {
    const completion = await collectStream(
      chunks({ choices: [{ message: { content: 'only message' }, finish_reason: 'stop' }] }),
    );

    expect(completion.choices?.[0]?.message?.content).toBe('only message');
  });

  it('reports a truncated answer, which the error classifier reads as output_truncated', async () => {
    const completion = await collectStream(
      chunks({ choices: [{ delta: { content: 'cut off here' }, finish_reason: 'length' }] }),
    );

    expect(completion.choices?.[0]?.finish_reason).toBe('length');
  });

  it('survives a stream that carries no usage at all', async () => {
    const completion = await collectStream(chunks({ choices: [{ delta: { content: 'x' } }] }));

    expect(completion.usage).toBeUndefined();
    expect(completion.choices?.[0]?.finish_reason).toBeNull();
  });
});

describe('Responses streaming and usage', () => {
  it('keeps the completed response containing tool evidence and usage', async () => {
    const response = await collectResponsesStream(
      chunks(
        { type: 'response.output_text.delta', delta: '{"born":' },
        {
          type: 'response.completed',
          response: {
            status: 'completed',
            output: [
              { type: 'web_search_call', status: 'completed', action: { type: 'open_page', url: 'https://example.org/a' } },
              { type: 'message', content: [{ type: 'output_text', text: '{"born":"1893"}' }] },
            ],
            usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
          },
        },
      ),
    );
    expect(response.status).toBe('completed');
    expect(response.output?.[0]?.type).toBe('web_search_call');
    expect(response.usage?.total_tokens).toBe(110);
  });

  it('keeps usage and the truncation reason when the stream ends `incomplete`', async () => {
    // The event a call that hits `max_output_tokens` ends with. Dropping it bills
    // a 30k-token answer as zero, hides it from the budget guard, and turns the
    // truncation into a retryable `response_format` — buying the identical cut
    // on every attempt.
    const response = await collectResponsesStream(
      chunks(
        { type: 'response.output_text.delta', delta: '{"born": {"value": "21.02' },
        {
          type: 'response.incomplete',
          response: {
            status: 'incomplete',
            incomplete_details: { reason: 'max_output_tokens' },
            usage: { input_tokens: 5000, output_tokens: 32_768, total_tokens: 37_768 },
            output: [{ type: 'message', content: [{ type: 'output_text', text: '{"born": {"value": "21.02' }] }],
          },
        },
      ),
    );

    expect(response.incomplete_details?.reason).toBe('max_output_tokens');
    expect(mapResponsesUsage(response.usage).totalTokens).toBe(37_768);
  });

  it('normalizes OmniRoute Chat cache tokens that were added twice', () => {
    const usage = mapChatUsage(
      {
        prompt_tokens: 26_271,
        completion_tokens: 5,
        total_tokens: 26_276,
        prompt_tokens_details: { cached_tokens: 13_056 },
      },
      'additional',
    );
    expect(usage.promptTokens).toBe(13_215);
    expect(usage.cachedPromptTokens).toBe(13_056);
    expect(usage.totalTokens).toBe(13_220);
  });

  it('records Responses cache reads and writes separately', () => {
    const usage = mapResponsesUsage({
      input_tokens: 1200,
      output_tokens: 20,
      total_tokens: 1220,
      input_tokens_details: { cached_tokens: 800, cache_write_tokens: 300 },
    });
    expect(usage).toMatchObject({
      promptTokens: 1200,
      cachedPromptTokens: 800,
      cacheWritePromptTokens: 300,
    });
  });
});
