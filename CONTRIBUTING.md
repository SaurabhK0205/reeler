# Contributing to Reeler

Thank you for your interest in contributing to Reeler. This document outlines our development workflows, coding standards, and verification guidelines.

## Branching Strategy

- `main`: Production branch. Protected, stable, and continuously deployed to live production.
- `staging`: Integration branch. All features and bug fixes land here first via squash merges.
- `feat/*`, `fix/*`, `chore/*`: Feature and fix branches created off `staging`.

### Workflow
1. Branch off `staging`.
2. Implement changes and add automated unit tests in `tests/`.
3. Verify that `npm test` passes with zero failures.
4. Submit a Pull Request targeting `staging`.
5. Ensure all automated AI code reviews (Gemini Code Auditor, NVIDIA Nemotron 550B, Qodo PR-Agent, and CodeRabbit) pass.
6. Squash merge into `staging`, then open a promotion PR from `staging` to `main`.

## Commit Conventions

- Use Conventional Commit prefixes (`feat:`, `fix:`, `chore:`, `refactor:`, `test:`, `docs:`).
- Commit messages must be clear, concise, and professional without emojis.
- All commits should be signed where possible.

## Testing & Quality Assurance

- Reeler uses Node.js native test runner with TypeScript type-stripping (`node --experimental-strip-types`).
- Run the full test suite locally before pushing:
  ```bash
  npm test
  ```
- Ensure any database changes in `supabase/migrations/` maintain exact parity with `schema.sql`.

## Security & Bug Reports

Please see [SECURITY.md](SECURITY.md) for vulnerability disclosure procedures.
