import { describe, it, expect } from 'vitest';
import { loadInstructions } from '../src/instructions.js';

describe('loadInstructions', () => {
  it('loads the packaged doctrine doc', () => {
    const text = loadInstructions();
    // It must carry the core front-door steer and the work-on-the-board
    // directive — the reasons the doc is worth shipping into context at all.
    expect(text).toContain('front door');
    expect(text.toLowerCase()).toContain('work tracker');
    expect(text.length).toBeGreaterThan(200);
  });

  it('falls back to a sane steer when the doc is missing', () => {
    const text = loadInstructions('/no/such/path/instructions.md');
    expect(text).toContain('front door');
  });
});
