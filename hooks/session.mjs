// SessionStart: inject only current mode, active work, blocked issues and violations.
import { findProject, readStdinJson } from '../lib/core.mjs';
import { statusText } from '../lib/status.mjs';

const input = readStdinJson();
const project = findProject(input.cwd || process.cwd());
if (!project) process.exit(0);
process.stdout.write(statusText(project) + '\n');
