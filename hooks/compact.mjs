// PostCompact (matcher auto): count this session's automatic compactions for the handoff check. A manual /compact is the
// user choosing to stay; the host does not fire this for subagents.
import path from 'node:path';
import { findProject, readJson, writeJsonAtomic, readStdinJson } from '../lib/core.mjs';

const input = readStdinJson();
const project = findProject(input.cwd || process.cwd());
if (!project || input.trigger !== 'auto') process.exit(0);
const file = path.join(project.harness, 'runtime', 'session.json');
const session_id = input.session_id || null;
const prev = readJson(file, {});
const s = prev.session_id === session_id ? prev : { session_id };
writeJsonAtomic(file, { ...s, compactions: (s.compactions || 0) + 1 }); // no ts: a compaction is not the user speaking
