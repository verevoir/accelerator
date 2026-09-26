import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/index.js';
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

const capabilityTools = [
  'provision',
  'find_governance',
  'delegate',
  'dispatch',
  'enact_capability',
];

describe('guidance follows the registered companion tools', () => {
  it.each([[], ...capabilityTools.map((name) => [name]), capabilityTools])(
    'mentions exactly the available capability tools: %j',
    (...registeredTools: string[]) => {
      const text = loadInstructions(undefined, { registeredTools });
      expect(capabilityTools.filter((name) => new RegExp(`\\b${name}\\b`).test(text))).toEqual(
        registeredTools
      );
    }
  );
});

describe('MCP initialization guidance', () => {
  it.each([
    { registeredTools: [], expected: [] },
    { registeredTools: ['provision'], expected: ['provision'] },
    { registeredTools: ['find_governance'], expected: ['find_governance'] },
  ])(
    'exposes only the available companion guidance: $expected',
    async ({ registeredTools, expected }) => {
      const server = await createServer({ registeredTools });
      const client = new Client({ name: 'instruction-test', version: '1.0.0' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      try {
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        expect(
          capabilityTools.filter((name) =>
            new RegExp(`\\b${name}\\b`).test(client.getInstructions() ?? '')
          )
        ).toEqual(expected);
      } finally {
        await client.close();
        await server.close();
      }
    }
  );
});

it('keeps fallback guidance and available companion guidance when documentation is missing', () => {
  expect(
    loadInstructions('/no/such/path/instructions.md', { registeredTools: ['provision'] })
  ).toContain('Before changing code, call `provision`');
});

it('ignores unknown companion names instead of emitting arbitrary instructions', () => {
  expect(loadInstructions(undefined, { registeredTools: ['unknown', 'PROVISION'] })).toBe(
    loadInstructions()
  );
});
