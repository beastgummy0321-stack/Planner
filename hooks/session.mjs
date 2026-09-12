// SessionStart: inject only the open feature (outcome, decisions, queue), what a /clear would lose, the last interruption, a due handoff check.
import { findProject, readStdinJson } from '../lib/core.mjs';
import { statusText, handoffCheck } from '../lib/status.mjs';

const input = readStdinJson();
const project = findProject(input.cwd || process.cwd());
if (!project) process.exit(0);
const advice = handoffCheck(project, input.session_id);
process.stdout.write(statusText(project) + (advice ? '\n' + advice : '') + '\n');
