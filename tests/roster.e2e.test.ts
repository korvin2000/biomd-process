import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runJob } from '../src/app/runJob.js';
import { FakeClient, Workspace, respond, echoTable, isStringBatch } from './helpers/workspace.js';

/**
 * The roster end to end: an article that does not name its subject fully, a
 * collective that has no personal name at all, and what each of them puts in
 * `out/`.
 */
const PERSON = `# Евгений Михайлович Русанов

::: lead
РУСАНОВ Евгений Михайлович **(1911-1967)**, – профессиональный гитарист.
:::
`;

const ENSEMBLE = `# Трио гитаристов Урала

::: lead
Известный российский ансамбль классических гитаристов из Челябинска.
:::

::: image
src: photo/t/trio_ural.jpg
caption: Трио гитаристов Урала
:::
`;

const ROSTER = [
  { fullname: 'Русанов Е.М.', surname: 'Русанов', forename: 'Е.', patronymic: 'М.', url: 'rusanov_em.bio.md' },
  {
    fullname: 'Трио гитаристов Урала',
    surname: 'Трио гитаристов Урала',
    url: 'trio_ural.bio.md',
    aliases: ['Уральское трио'],
  },
];

const MONONYM = `# Армик

::: lead
Американский гитарист.
:::
`;

/** The model answers the dates and the craft, and says nothing about the name. */
const NAMELESS_FACTS = { born: '1911', died: '1967', jobs: 'гитарист', type: 'guitarist', gender: 'm' };

const TASKS = {
  extract: { enabled: true },
  translate: { enabled: true, targetLanguages: ['en'] },
  localize: { enabled: true, targetLanguages: ['en'] },
  catalog: { enabled: true },
};

let workspace: Workspace;

beforeEach(async () => {
  workspace = await Workspace.create();
  await workspace.writeDefaultPrompts();
  await workspace.writeFile('corpus/ru/rusanov_em.bio.md', PERSON);
  await workspace.writeFile('corpus/ru/trio_ural.bio.md', ENSEMBLE);
  await workspace.writeFile('data/names.json', JSON.stringify(ROSTER));
});

afterEach(async () => {
  await workspace.destroy();
});

function app(overrides: Record<string, unknown> = {}) {
  const client = new FakeClient((call) => {
    if (isStringBatch(call.request)) return respond(echoTable(call.request));
    if (call.request.responseFormat?.type === 'json_object') return respond(JSON.stringify(NAMELESS_FACTS));
    return respond('translated');
  });
  return workspace.app({ tasks: TASKS, roster: { file: 'data/names.json' }, ...overrides } as never, client);
}

describe('the name roster, end to end', () => {
  it('fills the name the article never spelled out', async () => {
    const outcome = await runJob(app());
    expect(outcome.summary.status).toBe('completed');

    const dossier = JSON.parse(await readFile(workspace.path('out/ru/rusanov_em.bio.json'), 'utf8'));
    expect(dossier.metadata.surname).toBe('Русанов');
    // The patronymic travels with the forename: a dossier has no member for it.
    expect(dossier.metadata.forename).toBe('Е. М.');
    // And what the model *did* answer is untouched.
    expect(dossier.metadata.dates).toEqual({ born: '1911', died: '1967' });
  });

  it('never overwrites what the article said', async () => {
    const client = new FakeClient((call) => {
      if (isStringBatch(call.request)) return respond(echoTable(call.request));
      if (call.request.responseFormat?.type === 'json_object') {
        return respond(JSON.stringify({ ...NAMELESS_FACTS, forename: 'Евгений Михайлович', surname: 'Русанов' }));
      }
      return respond('translated');
    });
    const configured = workspace.app({ tasks: TASKS, roster: { file: 'data/names.json' } } as never, client);
    await runJob(configured);

    const dossier = JSON.parse(await readFile(workspace.path('out/ru/rusanov_em.bio.json'), 'utf8'));
    // The article spelled the given name out; the roster's initials do not win.
    expect(dossier.metadata.forename).toBe('Евгений Михайлович');
  });

  it('gives a collective its own name and the gender the format reserves for one', async () => {
    await runJob(app());

    const dossier = JSON.parse(await readFile(workspace.path('out/ru/trio_ural.bio.json'), 'utf8'));
    expect(dossier.metadata.surname).toBe('Трио гитаристов Урала');
    expect(dossier.metadata.forename).toBeUndefined();

    const index = JSON.parse(await readFile(workspace.path('out/index.json'), 'utf8'));
    const row = index.find((entry: { md: string }) => entry.md.includes('trio_ural'));
    // `mixed` *means* "a collective entry" (external/02), and the model said `m`.
    expect(row.gender).toBe('mixed');
  });

  it('publishes the roster aliases in the roster language and nowhere else', async () => {
    await runJob(app());

    const ru = JSON.parse(await readFile(workspace.path('out/index-ru.json'), 'utf8')) as Record<string, string[]>;
    const names = Object.values(ru).flat();
    expect(names).toContain('Уральское трио');

    // The roster's own heading is the *display* name, not one alias among
    // several: a person wrote `Русанов Е.М.` in the catalogue's own order, and
    // `Е. М. Русанов` is this tool's guess at what they meant.
    const person = Object.values(ru).find((entry) => entry[0]?.startsWith('Русанов'));
    expect(person?.[0]).toBe('Русанов Е.М.');
    expect(person).toContain('Е. М. Русанов');

    const en = JSON.parse(await readFile(workspace.path('out/index-en.json'), 'utf8'));
    expect(Object.values(en).flat()).not.toContain('Уральское трио');
  });

  it('keeps the members of an ensemble out of its display name', async () => {
    const client = new FakeClient((call) => {
      if (isStringBatch(call.request)) return respond(echoTable(call.request));
      if (call.request.responseFormat?.type === 'json_object') {
        // What a model actually answers for a trio: the members, in `forename`.
        return respond(JSON.stringify({ forename: 'Виктор Козлов, Виктор Ковба, Шариф Мухатдинов', type: 'musician' }));
      }
      return respond('translated');
    });
    await runJob(workspace.app({ tasks: TASKS, roster: { file: 'data/names.json' } } as never, client));

    const dossier = JSON.parse(await readFile(workspace.path('out/ru/trio_ural.bio.json'), 'utf8'));
    expect(dossier.metadata.forename).toBeUndefined();
    // Moved, not dropped: `external/05` calls `relatives` "related persons".
    expect(dossier.metadata.relatives).toBe('Виктор Козлов,Виктор Ковба,Шариф Мухатдинов');

    const index = JSON.parse(await readFile(workspace.path('out/index.json'), 'utf8'));
    const id = index.find((row: { md: string }) => row.md.includes('trio_ural')).id;
    const ru = JSON.parse(await readFile(workspace.path('out/index-ru.json'), 'utf8'));
    // The soloist in this fixture is handed the same answer and keeps it, which
    // is the point: only a collective has its given name reinterpreted.
    expect(ru[id]).toEqual(['Трио гитаристов Урала', 'Уральское трио']);
  });

  it('does not fill a family name that repeats the given name', async () => {
    // The mononym case: the article gives one name and the roster's only column
    // is the same word. "Армик Армик" is not a display name.
    await workspace.writeFile('corpus/ru/armik.bio.md', MONONYM);
    await workspace.writeFile(
      'data/names.json',
      JSON.stringify([...ROSTER, { fullname: 'Армик', surname: 'Армик', url: 'armik.bio.md' }]),
    );

    const client = new FakeClient((call) => {
      if (isStringBatch(call.request)) return respond(echoTable(call.request));
      if (call.request.responseFormat?.type === 'json_object') {
        return respond(JSON.stringify({ forename: 'Армик', type: 'guitarist', gender: 'm' }));
      }
      return respond('translated');
    });
    await runJob(workspace.app({ tasks: TASKS, roster: { file: 'data/names.json' } } as never, client));

    const dossier = JSON.parse(await readFile(workspace.path('out/ru/armik.bio.json'), 'utf8'));
    expect(dossier.metadata.forename).toBe('Армик');
    expect(dossier.metadata.surname).toBeUndefined();
  });

  it('promotes a lone collective name out of the given-name slot', async () => {
    const client = new FakeClient((call) => {
      if (isStringBatch(call.request)) return respond(echoTable(call.request));
      if (call.request.responseFormat?.type === 'json_object') {
        // No comma: this is the ensemble's name in the wrong member, not a
        // list of its members.
        return respond(JSON.stringify({ forename: 'Уральское трио гитаристов', type: 'musician' }));
      }
      return respond('translated');
    });
    await runJob(workspace.app({ tasks: TASKS, roster: { file: '' } } as never, client));

    const dossier = JSON.parse(await readFile(workspace.path('out/ru/trio_ural.bio.json'), 'utf8'));
    expect(dossier.metadata.forename).toBeUndefined();
    expect(dossier.metadata.surname).toBe('Уральское трио гитаристов');
    expect(dossier.metadata.relatives).toBeUndefined();
  });

  it('does not demand a given name from an ensemble', async () => {
    // The failure this prevents cost two of thirteen documents their dossier on
    // the first full run: `requiredFields: [forename, surname]` is written for
    // a soloist, and a quartet has no given name to supply.
    const client = new FakeClient((call) => {
      if (isStringBatch(call.request)) return respond(echoTable(call.request));
      if (call.request.responseFormat?.type === 'json_object') {
        return respond(JSON.stringify({ surname: 'Трио гитаристов Урала', type: 'musician' }));
      }
      return respond('translated');
    });
    const outcome = await runJob(
      workspace.app(
        {
          tasks: { ...TASKS, extract: { enabled: true, requiredFields: ['forename', 'surname'] } },
          roster: { file: '' },
        } as never,
        client,
      ),
    );

    const failed = outcome.summary.failures.map((failure) => failure.label).join(' ');
    expect(failed).not.toContain('trio_ural');
    // …and the rule still holds for a person, who does have one: the soloist in
    // this fixture is handed the same nameless answer and is rejected for it.
    expect(failed).toContain('rusanov_em');

    const dossier = JSON.parse(await readFile(workspace.path('out/ru/trio_ural.bio.json'), 'utf8'));
    expect(dossier.metadata.surname).toBe('Трио гитаристов Урала');
  });

  it('stays out of the way when it is turned off', async () => {
    await runJob(app({ roster: { file: '' } }));

    const dossier = JSON.parse(await readFile(workspace.path('out/ru/rusanov_em.bio.json'), 'utf8'));
    expect(dossier.metadata.surname).toBeUndefined();
  });
});
