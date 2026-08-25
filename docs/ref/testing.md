# Testing — the harness and its dispatch rule

`npm run typecheck && npm test` is the **whole gate**. There is no lint script and no
ESLint/Prettier config in this repo.

```bash
npx vitest run tests/catalog.test.ts
npx vitest run tests/catalog.test.ts -t "keeps the id an entry already had"
```

`vitest.config.ts`: `include: ['tests/**/*.test.ts']`, node environment, `restoreMocks: true`.
Test map: [source-map.md](source-map.md#tests).

## `Workspace` — an isolated on-disk project per test

`tests/helpers/workspace.ts` builds a temp dir and calls `createApp`, which is the same composition
root production uses. **Read it before writing any test**; every pattern below is already in it.

Exports: `Workspace` · `FakeClient` · `FakeCall` · `respond()` · `DEFAULT_FACTS` ·
`isStringBatch()` · `echoTable()` · `requestedTable()`.

## `FakeClient` — a scripted transport, never a real endpoint

Extraction, string batches and web search **all ask for `json_object`**, so they cannot be told
apart by `responseFormat`. They are told apart by **what the request carries**, and every test
dispatches on the last message's fenced block:

| Request shape | Is | Answered with |
|---|---|---|
| a ` ```json ` block | a `{key: text}` batch | `echoTable()` — echo every key back, i.e. an identity translation |
| a ` ```markdown ` block | an article | `DEFAULT_FACTS`, the flat card |
| a ` ```yaml ` block | a web-search identity card | whatever that test needs (`tests/websearch.e2e.test.ts:41`) |
| `json_object` with none of the above | extraction | the supplied facts |
| anything else | a whole-document translation | |

> `isStringBatch(request)` is the predicate for the first row; `requestedTable(call)` parses what a
> call actually asked for, which is how you assert that a fragment was **not** sent.

## What is worth asserting

- **that a call did not happen** — `foreignFragments`, `onExistingDossier: reuse`, `findGaps` with
  no gaps, and all three plan-time skips are all "no request was made" behaviours;
- **which keys were in the payload**, via `requestedTable` — the repair and narrowing ladders are
  defined by what the *second* call carries;
- **the artifact, not the response** — pipelines return artifacts and never write, so a unit test
  reads `TaskResult.artifacts` without touching disk;
- **`TaskResult.notes`** — a refused web answer, a date conflict recorded rather than published, an
  edition not declared, a mixed-alphabet word: these produce no file, and the notes are the only
  account of the decision.

## Conventions the compiler enforces

ESM + `NodeNext` + `verbatimModuleSyntax`: relative imports in `.ts` files need an explicit `.js`
extension (`from '../config/loader.js'`), and type-only imports use `import type`. Not a style
choice — the build fails otherwise.

`strict: true` plus `noUncheckedIndexedAccess: true`: array and index access types as
`T | undefined`. Also on: `noImplicitOverride`, `noFallthroughCasesInSwitch`,
`useUnknownInCatchVariables`, `isolatedModules`.

## The other suite

The translation regression scorer is model-free and separate from vitest — see
[prompts.md](prompts.md#measuring-a-prompt-change).

```bash
npm run score -- input/ru out
```
