// UserPromptSubmit: record the latest genuine user prompt. `harness mode` trusts only this file,
// so a model calling the Skill tool on its own cannot end /dig.
import path from 'node:path';
import { findProject, writeJsonAtomic, readStdinJson } from '../lib/core.mjs';

const input = readStdinJson();
const project = findProject(input.cwd || process.cwd());
if (!project) process.exit(0);
const prompt = String(input.prompt ?? input.user_prompt ?? '');
writeJsonAtomic(path.join(project.harness, 'runtime', 'last-prompt.json'), {
  prompt: prompt.slice(0, 2000), ts: Date.now(), session_id: input.session_id || null,
});
