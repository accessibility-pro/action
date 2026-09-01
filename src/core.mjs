/**
 * Minimal GitHub Actions toolkit.
 *
 * `@actions/core` would be the obvious dependency, but a JavaScript
 * action has to commit its `node_modules` (or a bundler output) to the
 * repo, and every transitive dependency then becomes a supply-chain
 * surface inside every customer's CI. The subset we need is ~120 lines
 * of the documented workflow-command protocol, so we implement it.
 */

import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

/** Escape a value for the `::command::` line format. */
function escapeData(value) {
  return String(value)
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A');
}

/** Escape a value for a workflow-command *property* (stricter). */
function escapeProperty(value) {
  return escapeData(value).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

function issueCommand(command, properties, message) {
  const props = Object.entries(properties || {})
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${escapeProperty(v)}`)
    .join(',');
  process.stdout.write(
    `::${command}${props ? ' ' + props : ''}::${escapeData(message ?? '')}\n`
  );
}

/**
 * Read an action input.
 *
 * GitHub exposes `with:` keys as `INPUT_<NAME>` with spaces replaced by
 * underscores. Hyphens are NOT replaced, so `wcag-level` arrives as
 * `INPUT_WCAG-LEVEL`.
 */
export function getInput(name, { required = false, trim = true } = {}) {
  const raw = process.env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] ?? '';
  const value = trim ? raw.trim() : raw;
  if (required && !value) {
    throw new Error(`Input required and not supplied: ${name}`);
  }
  return value;
}

/**
 * Split an input into a list.
 *
 * `separator` defaults to newlines only. A URL may legitimately contain
 * a comma (`?ids=1,2`), so splitting URLs on commas would silently scan
 * two malformed addresses instead of one real one.
 */
export function getListInput(name, { required = false, separator = /[\r\n]+/ } = {}) {
  const raw = getInput(name, { required, trim: false });
  return raw
    .split(separator)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Parse a boolean input per the YAML 1.2 core schema, the same set
 * `@actions/core.getBooleanInput` accepts. An unset input falls back to
 * `fallback` rather than throwing, so a caller on an older action
 * version that omits the key keeps working.
 */
export function getBooleanInput(name, fallback = false) {
  const value = getInput(name).toLowerCase();
  if (!value) return fallback;
  if (['true', 'yes', 'on', '1'].includes(value)) return true;
  if (['false', 'no', 'off', '0'].includes(value)) return false;
  throw new Error(
    `Input '${name}' must be a boolean (got '${value}'). Use true or false.`
  );
}

/**
 * Publish a step output.
 *
 * Uses the heredoc form unconditionally: a finding title containing a
 * newline in the `key=value` form would let arbitrary text be injected
 * as further outputs.
 */
export function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  const text = value === undefined || value === null ? '' : String(value);
  if (!file) {
    // Local runs (tests, `node src/main.mjs`) have no output file.
    info(`[output] ${name}=${text.split('\n')[0]}`);
    return;
  }
  const delimiter = `ghadelimiter_${randomUUID()}`;
  appendFileSync(file, `${name}<<${delimiter}\n${text}\n${delimiter}\n`, 'utf8');
}

export function info(message) {
  process.stdout.write(`${message}\n`);
}

export function debug(message) {
  issueCommand('debug', {}, message);
}

/** Log-level warning. `props` may carry title/file/line for annotations. */
export function warning(message, props = {}) {
  issueCommand('warning', props, message);
}

export function error(message, props = {}) {
  issueCommand('error', props, message);
}

export function notice(message, props = {}) {
  issueCommand('notice', props, message);
}

export function startGroup(name) {
  process.stdout.write(`::group::${name}\n`);
}

export function endGroup() {
  process.stdout.write('::endgroup::\n');
}

/** Register a value for automatic masking in the run log. */
export function setSecret(value) {
  if (value) issueCommand('add-mask', {}, value);
}

/** Append markdown to the run's job summary. */
export function appendSummary(markdown) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  appendFileSync(file, markdown.endsWith('\n') ? markdown : `${markdown}\n`, 'utf8');
}

export function setFailed(message) {
  error(message);
  process.exitCode = 1;
}
