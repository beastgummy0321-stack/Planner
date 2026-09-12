// UserPromptSubmit: remember which session is alive (a lease from another session is an orphan that `harness recover`
// re-queues), keep this session's compaction count, surface a due handoff check. The prompt itself is never stored.
import path from 'node:path';
import { findProject, readJson, writeJsonAtomic, readStdinJson } from '../lib/core.mjs';
import { handoffCheck } from '../lib/status.mjs';

const input = readStdinJson();
const project = findProject(input.cwd || process.cwd());
if (!project) process.exit(0);
const file = path.join(project.harness, 'runtime', 'session.json');
const session_id = input.session_id || null;
const prev = readJson(file, {});
writeJsonAtomic(file, { ...(prev.session_id === session_id ? prev : {}), session_id, ts: Date.now() });
const advice = handoffCheck(project, session_id);
if (advice) process.stdout.write(advice + '\n');
