#!/usr/bin/env node
/**
 * Custom NVIDIA Nemotron 3 Ultra 550B Pull Request Reviewer
 *
 * Performs deep reasoning architectural and concurrency audits:
 * - Anti-AI-slop (strictly no em-dashes, no filler, concise human phrasing)
 * - Atomic CAS correctness in reminder scheduling and choice operations
 * - Database parity between in-memory test stores and Supabase production queries
 * - 24-hour Meta messaging window compliance
 * - Single-bubble Instagram DM length ceiling (< 950 characters)
 */

import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const PR_NUMBER = process.env.PR_NUMBER;
const REPO = process.env.GITHUB_REPOSITORY;
const BASE_REF = process.env.GITHUB_BASE_REF || 'staging';

if (!NVIDIA_API_KEY) {
  console.log('Notice: NVIDIA_API_KEY secret is not configured. Skipping Nemotron automated PR review.');
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

// Limit diff payload size to 100k chars for fast processing
const truncatedDiff = diff.length > 100000 ? diff.slice(0, 100000) + '\n\n[Diff truncated...]' : diff;

const systemPrompt = `You are a Principal Systems Architect and Staff Security Auditor performing an automated deep reasoning code review on "Reeler", an asynchronous Instagram DM reminder bot and web vault built with Node.js/TypeScript and Supabase PostgreSQL.

YOUR MISSION:
Perform a deep architectural, concurrency, and security review on the provided Git diff. Identify subtle bugs, race conditions, and production anti-patterns that standard linters miss.

STRICT FORMATTING & STYLE RULES:
- NEVER use em-dashes (—). Always use colons (:), standard hyphens (-), or parentheses instead.
- Avoid generic AI boilerplate, conversational fluff, and sycophantic praise. Keep comments technical, direct, and concise.

AUDIT CRITERIA:
1. CONCURRENCY & ATOMIC CAS:
   - Verify that reminder scheduling, duration updates, and choice-window operations use atomic compare-and-swap (CAS) to prevent race conditions.
   - Check for race conditions in webhook handling and state transitions.

2. STORE PARITY (IN-MEMORY vs SUPABASE):
   - Verify 100% behavioral parity between InMemoryStore (used in tests) and Supabase PostgREST queries.
   - Check sorting, filtering, null handling, and limits.
   - All queries must be parameterized.

3. BOUNDARIES & INSTAGRAM PLATFORM LIMITS:
   - Single-bubble Instagram DM length ceiling (< 950 characters).
   - 24-hour Meta messaging window compliance across all reminder flows.
   - Zero unhandled promise rejections or unhandled null/undefined accesses.

4. SCHEMA INTEGRITY:
   - If any column or table is added/altered in supabase/migrations/, verify that root schema.sql is updated within the same change.

OUTPUT FORMAT:
Provide a clear, formatted GitHub Markdown review:
### NVIDIA Nemotron 3 Ultra 550B Deep Reasoning Audit

**Verdict**: [APPROVE | REQUEST_CHANGES | COMMENT]

#### Production Invariants Check
- [x or ] Concurrency & Atomic CAS Locks
- [x or ] Store Parity (InMemoryStore vs Supabase)
- [x or ] Meta 24h Window & DM Length Ceiling (< 950 chars)
- [x or ] Anti-AI-slop & Human Copy (no em-dashes)
- [x or ] Error Handling & Fail-Closed State

#### Deep Reasoning Findings
(Detail specific architectural risks, subtle race conditions, or edge cases with file paths and line references. If clean, state "No architectural vulnerabilities or race conditions detected. Production invariants satisfied.")
`;

async function runReview() {
  const modelName = 'nvidia/nemotron-3-ultra-550b-a55b';
  const url = 'https://integrate.api.nvidia.com/v1/chat/completions';

  console.log(`Sending PR #${PR_NUMBER} diff (${diff.length} bytes) to NVIDIA NIM (${modelName})...`);

  let reviewBody = null;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NVIDIA_API_KEY}`,
        'Content-Type': 'application/json'
      },
      signal: AbortSignal.timeout(30000),
      body: JSON.stringify({
        model: modelName,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `--- GIT DIFF FOR PULL REQUEST #${PR_NUMBER} ---\n\n${truncatedDiff}` }
        ],
        temperature: 0.1,
        max_tokens: 2048
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.warn(`NVIDIA API error with model ${modelName} (${response.status}):`, errorText);
      throw new Error(`NVIDIA API error ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    reviewBody = data?.choices?.[0]?.message?.content;
  } catch (err) {
    console.error(`Request failed with model ${modelName}:`, err.message || err);
    process.exit(1);
  }

  if (!reviewBody) {
    console.error('Failed to generate review with NVIDIA Nemotron model.');
    process.exit(1);
  }

  // Sanitize any stray em-dashes if generated
  reviewBody = reviewBody.replace(/—/g, ' - ');

  console.log('Review generated successfully. Posting comment to GitHub PR...');

  const commentUrl = `https://api.github.com/repos/${REPO}/issues/${PR_NUMBER}/comments`;
  const postCommentRes = await fetch(commentUrl, {
    method: 'POST',
    headers: {
      'Authorization': `token ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      body: reviewBody + '\n\n---\n*Automated deep reasoning review by NVIDIA Nemotron 3 Ultra 550B*'
    })
  });

  if (!postCommentRes.ok) {
    const commentErr = await postCommentRes.text();
    console.error(`Failed to post comment to PR #${PR_NUMBER}:`, commentErr);
    process.exit(1);
  }

  console.log(`Successfully posted Nemotron code review to PR #${PR_NUMBER}!`);
}

runReview().catch((err) => {
  console.error('Fatal error during review execution:', err);
  process.exit(1);
});
