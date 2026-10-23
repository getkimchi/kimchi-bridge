// All payloads stay on stdin to the bundled helper. No prompt/context writes.
async function record($, stage, event, result) {
  try {
    const root = $.plugin.root;
    const sessionId = await $.session.id();
    const cwd = await $.session.cwd();
    const version = (await $.session.version()).version;
    await $.process.run([root + '/bin/kimchi-adapters', 'hook', 'claude-code'], {
      stdin: JSON.stringify({stage, event, result, sessionId, cwd, version}),
      timeoutMs: 2000
    });
  } catch {
    // Fail open; the helper's health/coverage report exposes capture gaps.
  }
}
export function register(on) {
  on('session.start', async ($, e, next) => { await record($, 'session.start', e); return next(e); });
  on('classic.UserPromptSubmit', async ($, e, next) => { await record($, 'classic.UserPromptSubmit', e); return next(e); });
  on('turn.start', async ($, e, next) => { await record($, 'turn.start', e); return next(e); });
  on('tool.call', async ($, e, next) => {
    await record($, 'tool.before', e);
    try {
      const result = await next(e);
      await record($, 'tool.after', e, result);
      return result;
    } catch (error) {
      await record($, 'PostToolUseFailure', e);
      throw error;
    }
  });
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e);
    await record($, 'step.after', e, result);
    return result;
  });
  on('classic.PostToolUse', async ($, e, next) => { await record($, 'classic.PostToolUse', e); return next(e); });
  on('classic.SubagentStart', async ($, e, next) => { await record($, 'classic.SubagentStart', e); return next(e); });
  on('classic.SubagentStop', async ($, e, next) => { await record($, 'classic.SubagentStop', e); return next(e); });
  on('classic.Stop', async ($, e, next) => { await record($, 'classic.Stop', e); return next(e); });
  on('telemetry.log', {to: 'collector'}, async ($, e, next) => { await record($, 'telemetry.log', e); return next(e); });
}
