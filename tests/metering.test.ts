import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { registerModelCatalog } from '@verevoir/llm';
import { meterFooter, resolveMeterMode, roundUsage, formatMs } from '../src/metering.js';

describe('meterFooter (STDIO-385)', () => {
  beforeAll(() => {
    registerModelCatalog([
      {
        provider: 'samba',
        family: 'mtr-deepseek',
        modelClass: 'extraction',
        currentId: 'DeepSeek-V3.2',
        rates: [0.6, 1.5],
        label: 'DeepSeek V3.2',
        prefixes: ['DeepSeek-V3'],
      },
    ]);
  });

  it('appends nothing for mode "none"', () => {
    expect(meterFooter([roundUsage('DeepSeek-V3.2', 1000, 500)], 'none')).toBe('');
  });

  it('appends nothing when there are no rounds', () => {
    expect(meterFooter([], 'totals-only')).toBe('');
  });

  it('"totals-only" appends a total table with the concrete model, class, tokens, and a price', () => {
    const out = meterFooter([roundUsage('DeepSeek-V3.2', 1000, 500)], 'totals-only');
    expect(out).toContain('metering total');
    expect(out).toContain('DeepSeek V3.2');
    expect(out).toContain('(extraction)');
    expect(out).toMatch(/\$\d/); // a real price, not $0
    expect(out).not.toContain('metering by stage');
  });

  it('"verbose" adds a line per stage plus the total', () => {
    const out = meterFooter(
      [roundUsage('DeepSeek-V3.2', 1000, 500), roundUsage('DeepSeek-V3.2', 200, 100)],
      'verbose',
      { stageLabels: ['grep', 'read_file'] }
    );
    expect(out).toContain('metering by stage');
    expect(out).toContain('grep:');
    expect(out).toContain('read_file:');
    expect(out).toContain('metering total');
  });

  it('reports cache read / write tokens when a round has them, priced into the line', () => {
    // 1000 input of which 800 were cache reads, 200 cache writes — the meter
    // shows the cache split so the prompt-cache saving is visible.
    const out = meterFooter([roundUsage('DeepSeek-V3.2', 200, 100, 800, 200)], 'totals-only');
    expect(out).toContain('cache 800 read / 200 write');
  });

  it('omits the cache note entirely when a round has no cache tokens', () => {
    const out = meterFooter([roundUsage('DeepSeek-V3.2', 1000, 500)], 'totals-only');
    expect(out).not.toContain('cache');
  });

  it('renders elapsed time on the total when timing is supplied', () => {
    const out = meterFooter([roundUsage('DeepSeek-V3.2', 1000, 500)], 'totals-only', {
      timing: { totalMs: 1500 },
    });
    expect(out).toContain('elapsed: 1.5s');
  });

  it('renders per-stage time in verbose when roundMs is supplied', () => {
    const out = meterFooter(
      [roundUsage('DeepSeek-V3.2', 1000, 500), roundUsage('DeepSeek-V3.2', 200, 100)],
      'verbose',
      { stageLabels: ['first', 'second'], timing: { roundMs: [820, 60], totalMs: 880 } }
    );
    expect(out).toContain('first:');
    expect(out).toContain('820ms');
    expect(out).toContain('elapsed: 880ms');
  });
});

describe('formatMs', () => {
  it('renders sub-second, second, and minute scales legibly', () => {
    expect(formatMs(820)).toBe('820ms');
    expect(formatMs(1500)).toBe('1.5s');
    expect(formatMs(64000)).toBe('1m04s');
  });
});

describe('resolveMeterMode (STDIO-387)', () => {
  afterEach(() => {
    delete process.env.AIGENCY_METER;
  });

  it('uses an explicit per-call mode over the env default', () => {
    process.env.AIGENCY_METER = 'verbose';
    expect(resolveMeterMode('totals-only')).toBe('totals-only');
  });

  it('falls back to the AIGENCY_METER env when no explicit mode is given', () => {
    process.env.AIGENCY_METER = 'verbose';
    expect(resolveMeterMode()).toBe('verbose');
  });

  it('defaults to none when neither an explicit mode nor the env is set', () => {
    delete process.env.AIGENCY_METER;
    expect(resolveMeterMode()).toBe('none');
  });

  it('ignores an unrecognised env value rather than honouring a typo', () => {
    process.env.AIGENCY_METER = 'loud';
    expect(resolveMeterMode()).toBe('none');
  });
});
