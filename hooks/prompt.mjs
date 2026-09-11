// UserPromptSubmit: remember which session is alive. A lease from another session is an orphan that `harness recover` re-queues.
import path from 'node:path';
import { findProject, writeJsonAtomic, readStdinJson } from '../lib/core.mjs';

const input = readStdinJson();
const project = findProject(input.cwd || process.cwd());
if (!project) process.exit(0);
writeJsonAtomic(path.join(project.harness, 'runtime', 'session.json'), { session_id: input.session_id || null, ts: Date.now() });
