// Observe without changing model context, decisions, tool results or streams.
async function record($, stage, event, result) {
  try {
    const helper = await $.env.get('PROBE_HELPER');
    await $.process.run([helper, 'record', JSON.stringify({stage, event, result})]);
  } catch {
    // The runner detects absent records. Never print or affect native execution.
  }
}
export function register(on) {
  // The native mod compiler requires literal names AND literal/named functions.
  on('session.start', async ($, e, next) => { await record($, 'session.start', e); return next(e); });
  on('turn.start', async ($, e, next) => { await record($, 'turn.start', e); return next(e); });
  on('turn.complete', async ($, e, next) => { await record($, 'turn.complete', e); return next(e); });
  on('classic.PreToolUse', async ($, e, next) => { await record($, 'classic.PreToolUse', e); return next(e); });
  on('classic.PostToolUse', async ($, e, next) => { await record($, 'classic.PostToolUse', e); return next(e); });
  on('classic.Stop', async ($, e, next) => { await record($, 'classic.Stop', e); return next(e); });
  on('turn.step', async function* ($, e, next) {
    await record($, 'step.before', e);
    const result = yield* next(e);
    await record($, 'step.after', e, result);
    return result;
  });
  on('tool.call', async ($, e, next) => {
    await record($, 'tool.before', e);
    const result = await next(e);
    await record($, 'tool.after', e, result);
    return result;
  });
  on('telemetry.log', {to: 'collector'}, async ($, e, next) => {
    await record($, 'telemetry.log', e);
    return next(e);
  });
}
