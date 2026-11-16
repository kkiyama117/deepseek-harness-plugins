/** Write each bash call's sandbox facts as one tool_facts NDJSON line on stdout. */
export const name = 'sandbox-facts';
export const inject = ['tools'];

const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Return the tool_facts line for one execution result, or undefined when it carries no valid facts. */
export function factsLine(exec, result) {
  if (!isObject(exec) || exec.name !== 'bash' || typeof exec.callId !== 'string') return undefined;
  if (!isObject(result) || result.isError !== false) return undefined;
  if (!isObject(result.value)) return undefined;
  const sandbox = result.value.sandbox;
  if (!isObject(sandbox)) return undefined;
  const { mode, denied, enforcement, runnerFailed } = sandbox;
  if (typeof mode !== 'string' || typeof denied !== 'boolean') return undefined;
  if (enforcement !== undefined && enforcement !== 'full' && enforcement !== 'partial') return undefined;
  if (runnerFailed !== undefined && typeof runnerFailed !== 'boolean') return undefined;
  return JSON.stringify({
    type: 'tool_facts',
    callId: exec.callId,
    tool: 'bash',
    sandbox: {
      mode,
      denied,
      enforcement: enforcement === undefined ? null : enforcement,
      runnerFailed: runnerFailed === true,
    },
  }) + '\n';
}

/** Build the tools/result listener that writes one line per bash call and contains writer failures. */
export function createListener(write, warn) {
  return (exec, result) => {
    const line = factsLine(exec, result);
    if (line === undefined) return;
    try {
      write(line);
    } catch {
      try {
        warn(`sandbox-facts: write failed for ${exec.callId}`);
      } catch {}
    }
  };
}

export function apply(ctx) {
  ctx.on('tools/result', createListener(
    chunk => process.stdout.write(chunk),
    message => ctx.logger.warn(message),
  ));
}
