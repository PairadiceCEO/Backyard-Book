#!/usr/bin/env node
// node agents/run.mjs AGENT_ID   (claude-small | claude-big | openai | gemini)
// Signs in as that agent's player account (Firebase Auth REST, the public web API key), plays one session through our
// own /api, prints the run summary (and adds it to the GitHub Actions job summary), and exits. Never prints secrets.
// Exit code: 0 for a run that played or was skipped cleanly (no credit, quota, missing secrets); 1 only for a runner bug.
// Environment: see agents/README.md and .github/workflows/agents.yml.

import { appendFileSync } from 'node:fs';
import { AGENTS, runAgent } from './lib/runner.mjs';

const agentId = process.argv[2];
if (!AGENTS[agentId]) {
  console.error(`Usage: node agents/run.mjs <${Object.keys(AGENTS).join(' | ')}>`);
  process.exit(2);
}

const { summary, text } = await runAgent({ agentId });
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY) {
  try {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n\n`);
  } catch {
    // The console log above is enough.
  }
}
process.exit(summary.outcome === 'failed' ? 1 : 0);
