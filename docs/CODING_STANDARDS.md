# Coding Standards & Engineering Invariants

This document outlines the coding standards, architectural invariants, security guidelines, and development workflows for `reeler` (`instagram-saved-reels`).

---

## 1. Core Principles

1. **Fail-Closed Security**: Every boundary (API endpoint, webhook listener, database query, user vault) must validate authentication, enforce strict rate limiting, and fail closed upon unexpected errors or missing context.
2. **Deterministic & Auditable State**: State mutations (e.g., watch status, reminder scheduling, deletion barriers) must use atomic Compare-And-Swap (CAS) tokens or transactional checks to prevent race conditions.
3. **Data Isolation**: Multi-tenant sender data is strictly partitioned by sender ID and vault authentication tokens. No cross-sender queries, token leakage, or shared creator overrides are permitted.
4. **Resilient Background Processing**: Webhook deliveries and worker jobs are designed for at-least-once execution with deduplication and idempotency keys.

---

## 2. TypeScript & Execution Environment

* **Node.js**: Requires Node.js `>= 24.0.0`.
* **Execution**: Uses native Node.js type stripping (`--experimental-strip-types`) without an intermediate compilation or bundle step.
* **Strict Type Safety**:
  * Avoid `any` where a concrete interface, union, or generic type is possible.
  * Use tagged error types or domain error classes (e.g., `SenderReminderConflictError`, `SenderDeletionBarrierError`, `OtpCapacityError`).
  * Explicitly handle nullable and optional properties (`null` vs `undefined`).
* **ES Modules**: All imports must include file extensions (e.g., `import { Repository } from '../db/repository.ts'`) adhering to Node.js ESM standards.

---

## 3. Security & Input Sanitization

* **SQL & ILIKE Injection Prevention**:
  * Never concatenate untrusted strings into SQL or PostgREST queries.
  * When performing `ILIKE` searches, escape wildcard characters `\`, `%`, and `_` using `/([\\_%])/g`.
* **Cryptographic Primitives**:
  * Never use `Math.random()` for security, tokens, OTPs, or rate limiting salts. Use `node:crypto` (`crypto.randomBytes`, `crypto.timingSafeEqual`, `crypto.createHmac`).
  * Compare sensitive strings (tokens, hashes, signatures) with constant-time equality (`safeStringEqual`).
* **Regular Expression Denial of Service (ReDoS)**:
  * All regex patterns matching user inputs must be bounded in length and repetition (`{1,64}` or `{3,9}`).
  * Prefer `O(1)` `Set.has()` lookups for fixed keyword or command matching over complex regular expressions.
  * Avoid catastrophic backtracking patterns (`(a+)+`).
* **Log Sanitization**:
  * Never log raw passwords, access tokens, webhook verify tokens, session secrets, or full recipient identifiers.
  * Redact recipient IDs in production logs (e.g., `[REDACTED_SENDER]`).

---

## 4. Git & Commit Guidelines

* **Conventional Commits**: Every commit message must follow the Conventional Commits specification:
  * `feat:` A new user-facing feature.
  * `fix:` A bug fix.
  * `docs:` Documentation-only changes.
  * `style:` Code style changes (formatting, missing semi-colons, no code change).
  * `refactor:` Code restructuring without fixing a bug or adding a feature.
  * `perf:` Performance improvements.
  * `test:` Adding or updating tests.
  * `chore:` Maintenance tasks, dependency updates, CI/CD configuration.
* **Zero Emoji Policy**: Do not include emojis in commit subjects or commit descriptions. Keep commit subjects concise, imperative, and lowercase.
* **Branching Strategy**:
  * `main`: Production-ready release branch.
  * `staging`: Pre-production integration branch.
  * Feature/Fix branches: Branched from `staging`, PR-merged into `staging`, then promoted from `staging` to `main`. Never delete `staging`.

---

## 5. Code Formatting & Linting

* **Linter**: ESLint with TypeScript flat config (`eslint.config.mjs`).
  * Run lint check: `npm run lint`
* **Formatter**: Prettier configured with:
  * Single quotes (`'`)
  * Trailing commas on all multi-line structures (`trailingComma: "all"`)
  * Line width: 100 characters
  * Tab width: 2 spaces
  * Semicolons: Required (`semi: true`)
  * Run format check: `npm run format:check`
  * Auto-format: `npm run format`

---

## 6. Testing & CI Verification

* **Test Suite**: Run tests with `npm test`. All 24 test suites across unit, integration, and security runners must pass with zero failures.
* **Automated CI Gating**:
  * Every pull request is audited by automated AI reviewers: Gemini Code Auditor, NVIDIA Nemotron 3 Ultra 550B, Qodo PR-Agent, and CodeRabbit.
  * CodeQL static analysis runs automatically on all PRs and pushes to `main` and `staging`. Zero open security alerts are maintained at all times.
