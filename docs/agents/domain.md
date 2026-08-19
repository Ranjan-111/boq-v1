# Domain Docs

This repository uses a single-context domain-document layout.

## Before exploring

Read these sources when they exist:

- `CONTEXT.md` at the repository root.
- Relevant ADRs under `docs/adr/`.

If they do not exist, proceed without treating their absence as an error. Domain documents and ADRs are created when terminology or architectural decisions are formally resolved.

## Vocabulary

Use the project glossary’s terms in issue titles, specifications, tests and implementation discussions.

Do not introduce synonyms for concepts the glossary defines. If a necessary concept is absent, reconsider whether existing vocabulary covers it or record the gap for domain modelling.

## Architectural decisions

Surface conflicts with an existing ADR explicitly. Do not silently override an accepted architectural decision.

## Layout

- `CONTEXT.md` — project domain glossary and model.
- `docs/adr/` — system-wide architectural decision records.
- `docs/agents/` — engineering-skill configuration.
