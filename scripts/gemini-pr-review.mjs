#!/usr/bin/env node
/**
 * Custom Gemini Pull Request Reviewer
 *
 * Evaluates git diff against strict production standards:
 * - Anti-AI-slop (no em-dashes, no fluff, concise human phrasing)
 * - Atomic CAS correctness in reminder and choice operations
 * - Database parity between in-memory test stores and Supabase production queries
 * - Parameterized query injection defense
 * - Schema parity with root schema.sql
 * - Single-bubble Instagram DM length ceiling (< 950 characters)
 */

import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const PR_NUMBER = process.env.PR_NUMBER;
const REPO = process.env.GITHUB_REPOSITORY;
const BASE_REF = process.env.GITHUB_BASE_REF || 'staging';

if (!GEMINI_API_KEY) {
  console.log('Notice: GEMINI_API_KEY secret is not configured. Skipping Gemini automated PR review.');
  process.exit(0);
}

if (!GITHUB_TOKEN || !PR_NUMBER || !REPO) {
  console.error('Missing required GitHub environment variables (GITHUB_TOKEN, PR_NUMBER, GITHUB_REPOSITORY).');
  process.exit(1);
}

// 1. Get git diff against base branch
let diff = '';
try {
  execSync(`git fetch origin ${BASE_REF} --depth=50`, { stdio: 'inherit' });
  diff = execSync(`git diff origin/${BASE_REF}...HEAD`, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
} catch (err) {
  console.error('Failed to compute git diff:', err);
  process.exit(1);
}

if (!diff.trim()) {
  console.log('No diff detected against base branch.');
  process.exit(0);
}

// Limit diff payload size to 100k chars for fast token processing
const truncatedDiff = diff.length > 100000 ? diff.slice(0, 100000) + '\n\n[Diff truncated...]' : diff;

// 2. Read project guidance if present
let productContext = '';
if (existsSync('PRODUCT.md')) {
  productContext = readFileSync('PRODUCT.md', 'utf-8');
}

const systemPrompt = `You are a Principal Staff Software Engineer and Security Auditor performing an automated PR review on "Reeler", a production-grade Instagram DM bookmarking bot and web vault.

YOUR MISSION:
Ensure ONLY high-quality, production-ready, robust code is merged. Actively eradicate AI slop, conversational filler, and structural bugs.

REVIEW CRITERIA:
1. STRICT ANTI-AI-SLOP:
   - Reject any em-dashes (—) in code, strings, documentation, or messages.
   - Reject conversational fluff, robot apologies, sycophantic comments, and generic AI templates.
   - User-facing bot copy must be human, direct, concise, and under 950 characters (Instagram DM single-bubble ceiling).

2. CONCURRENCY & ATOMIC CAS:
   - Verify that reminder scheduling, duration updates, and choice-window operations use atomic compare-and-swap (CAS) to prevent race conditions.

3. REPOSITORY & DATABASE PARITY:
   - Ensure the in-memory store (used in tests) and Supabase PostgreSQL queries have identical behavior (e.g. fallback handling, null sorting, and limits).
   - Ensure all queries are parameterized via Supabase query builder. No string interpolation in queries.

4. SCHEMA INTEGRITY:
   - If any database column or table is added/altered in supabase/migrations/, verify that root schema.sql is updated within the same change.

5. ERROR HANDLING & RESILIENCE:
   - Zero unhandled promise rejections.
   - Webhook responses must be non-blocking and acknowledged fast.

OUTPUT FORMAT:
Provide a clear, formatted GitHub Markdown review:
### Gemini Production Quality Review

**Verdict**: [APPROVE | REQUEST_CHANGES | COMMENT]

#### Production Invariants Check
- [x or ] Anti-AI-slop & Human Copy (no em-dashes, concise copy)
- [x or ] Concurrency & Atomic CAS Locks
- [x or ] Repository & Supabase Query Parity
- [x or ] Schema Parity (schema.sql up to date)
- [x or ] Input Validation & Security

#### Findings & Recommendations
(List specific actionable findings with file paths, or state "No critical issues detected. Production standards satisfied." if clean.)
`;

async function getAvailableModels(apiKey) {
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`, {
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data?.models)) {
        const supported = data.models
          .filter((m) => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
          .map((m) => m.name.replace(/^models\//, ''));
        if (supported.length > 0) {
          console.log(`Discovered ${supported.length} available Gemini models from API:`, supported.slice(0, 5).join(', '));
          const flashModels = supported.filter((m) => m.includes('flash'));
          const otherModels = supported.filter((m) => !m.includes('flash'));
          return [...flashModels, ...otherModels];
        }
      }
    } else {
      console.warn(`Could not list models (${res.status}):`, await res.text());
    }
  } catch (err) {
    console.warn('Could not query model list, falling back to static list:', err.message || err);
  }
  return ['gemini-3.8-flash', 'gemini-2.5-flash', 'gemini-2.0-flash'];
}

async function runReview() {
  const candidateModels = await getAvailableModels(GEMINI_API_KEY);

  let reviewBody = null;
  let lastError = null;

  for (const modelName of candidateModels) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${GEMINI_API_KEY}`;
    console.log(`Sending PR #${PR_NUMBER} diff (${diff.length} bytes) to Gemini API (${modelName})...`);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(15000),
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [
                { text: systemPrompt },
                { text: `\n\n--- GIT DIFF FOR PULL REQUEST #${PR_NUMBER} ---\n\n${truncatedDiff}` }
              ]
            }
          ],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 2048,
          }
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.warn(`Gemini API error with model ${modelName} (${response.status}):`, errorText);
        lastError = errorText;
        continue;
      }

      const data = await response.json();
      reviewBody = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (reviewBody) {
        console.log(`Review successfully generated using model ${modelName}.`);
        break;
      }
    } catch (err) {
      console.warn(`Request failed with model ${modelName}:`, err.message || err);
      lastError = String(err.message || err);
    }
  }

  if (!reviewBody) {
    console.error('Failed to generate review with any candidate Gemini model. Last error:', lastError);
    process.exit(1);
  }

  console.log('Review generated successfully. Posting comment to GitHub PR...');

  // Post comment to PR
  const commentUrl = `https://api.github.com/repos/${REPO}/issues/${PR_NUMBER}/comments`;
  const postCommentRes = await fetch(commentUrl, {
    method: 'POST',
    headers: {
      'Authorization': `token ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      body: reviewBody + '\n\n---\n*Automated review by Gemini Principal Code Auditor*'
    })
  });

  if (!postCommentRes.ok) {
    const commentErr = await postCommentRes.text();
    console.error(`Failed to post comment to PR #${PR_NUMBER}:`, commentErr);
    process.exit(1);
  }

  console.log(`Successfully posted Gemini code review to PR #${PR_NUMBER}!`);
}

runReview().catch((err) => {
  console.error('Fatal error during review execution:', err);
  process.exit(1);
});
