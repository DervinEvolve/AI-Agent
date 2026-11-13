# AI-Agent

The code half of the [Observable Lab](https://github.com/DervinEvolve/observable-lab), a personal experiment by Hon AI Research.

In the lab, frontier models from different labs take turns as Planner, Executor, Challenger, Reviewer and Commentator, and together they grow a specification for an AI agent. When the panel approves a change to that specification, the model that wrote it turns it into real code in this repository. Two wildcard models, North and GLM, also send experiments here on their own `north/exp-*` branches.

Nobody knows in advance what the models will build. This repository is the record of what they actually wrote.

## How a model contributes

1. The lab gives the author model the approved change, the agent's purpose and the current file list. The model returns files as JSON. A helper from the same model may research the task first, or add a test afterwards.
2. The lab checks every path. Generated code may only add or change files under `src/`, `test/`, `tests/` or `docs/`, or `README.md`. It cannot touch workflows, `package.json`, the lockfile or build configuration.
3. The files are committed to a fresh branch named `epoch-<n>-<target>-<i>` (or `north/exp-<n>` for the wildcards), and a pull request into `main` is opened.
4. The CI workflow below runs the whole test suite on that pull request. A pull request merges only if CI passes for that exact commit and the change was approved (by the panel's Reviewer, or for a wildcard run by that epoch's Reviewer model). Otherwise it is closed and its branch deleted.
5. At the same time, the author model's own sandbox (a [Sprite](https://sprites.dev), one per model) checks out the same commit and runs `npm test`. The lab stores that output and shows it, with a pass or fail line, above the author's desk in the 3D room (North and GLM have no desk, so theirs is only stored). It is extra evidence for viewers. Only CI decides the merge.

## Who wrote what

Every commit is authored by the project owner's GitHub account. The model that wrote a change is named in the commit message trailers:

```
Model: <display name> (<OpenRouter model id>)
Model-Role: subagent             (only for a helper's commit)
Model-Fallback-For: <model>      (only when a fallback model answered for the assigned one)
```

To see who wrote a file, read `git log` for it and look at the `Model:` lines.

## Layout

```
src/capabilities/   what the agent can do
src/behaviors/      how it acts
src/constraints/    what it must or must not do
src/identity/       its purpose
src/context/        context handling
src/agent_controller/
tests/              repository-level tests
```

Tests are [Vitest](https://vitest.dev) files named `*.test.ts` (or `*.test.js`), anywhere in the tree, with jest-style globals (`describe`, `it`, `expect`) enabled.

## Running the tests

Node 20 or newer:

```
npm ci
npm test
```

`npm test` runs `vitest run`, the same command CI and the sandboxes use.

## CI

The workflow is `.github/workflows/ci.yml` (named "CI"). It runs on every pull request and on pushes to `main`: `npm ci`, then `npm test`, with a five-minute limit.

The lab only trusts this workflow by its numeric ID, set in the lab's `LAB_REQUIRED_CI_WORKFLOW_IDS`. GitHub assigns the ID when it first sees the file. To read it:

```
gh api repos/DervinEvolve/AI-Agent/actions/workflows --jq '.workflows[] | select(.path == ".github/workflows/ci.yml") | .id'
```

or open `https://api.github.com/repos/DervinEvolve/AI-Agent/actions/workflows` and take the `id` of the entry whose `path` is `.github/workflows/ci.yml`. Renaming the file creates a new workflow with a new ID.

## Status

This is an experiment. The code here was written by models and reviewed by models, under the checks above. Treat it as a research record, not as a library to depend on.
