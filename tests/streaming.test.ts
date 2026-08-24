import { describe, expect, it } from 'vitest';

import { collectStream } from '../src/llm/OpenAiCompatibleClient.js';

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
