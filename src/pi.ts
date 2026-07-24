import { z } from 'zod';
import { registerSourceTools } from './tools/source.js';
import { registerWorkflowTools } from './tools/workflow.js';
import {
  gateNativeToolCall,
  scopeFromEnv,
  withScope,
  type Scope,
  type ToolHost,
} from './permissions.js';

/**
 * pi (pi-coding-agent) plugin entry for `@verevoir/accelerator`.
 *
 * The same host-agnostic tool definitions that back the MCP server are
 * registered onto pi through the {@link ToolHost} seam, gated by the
 * `ACCELERATOR_TOOLS` scope, and — when `ACCELERATOR_GOVERN_NATIVE` is on — the
 * SAME scope policy is applied to pi's native tools via a `tool_call` gate.
 *
 * This is a policy + least-privilege + audit layer, NOT an isolation boundary:
 * the real sandbox is running pi in a container.
 */

// -----------------------------------------------------------------------------
// pi API — structural slice, declared locally
// -----------------------------------------------------------------------------
// Declared here so this package carries NO hard dependency on
// @earendil-works/pi-coding-agent: pi loads the built extension dynamically and
// passes its real `pi` object, so we only need the shape of what we call.
// Grounded in pi's dist/core/extensions/types.d.ts (ToolDefinition,
// ToolCallEvent, ToolCallEventResult, ExtensionContext) and pi-agent-core's
// AgentToolResult.

export interface PiToolContent {
  type: 'text';
  text: string;
}

export interface PiToolResult {
  content: PiToolContent[];
  details?: unknown;
  isError?: boolean;
}

export interface PiToolDefinition {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  /** TypeBox/JSON-Schema-shaped parameter schema; pi validates against it. */
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown
  ) => Promise<PiToolResult>;
}

export interface PiToolCallEvent {
  type: 'tool_call';
  toolCallId: string;
  toolName: string;
  /** Mutable tool arguments; unused here — we only ever block. */
  input: Record<string, unknown>;
}

export interface PiToolCallEventResult {
  block?: boolean;
  reason?: string;
}

export interface PiExtensionContext {
  hasUI: boolean;
}

export interface PiExtensionAPI {
  registerTool(tool: PiToolDefinition): void;
  on(
    event: 'tool_call',
    handler: (
      event: PiToolCallEvent,
      ctx: PiExtensionContext
    ) => PiToolCallEventResult | void | Promise<PiToolCallEventResult | void>
  ): void;
}

// -----------------------------------------------------------------------------
// MCP tool config/handler shapes seen by the ToolHost seam
// -----------------------------------------------------------------------------

interface McpToolConfig {
  description?: string;
  inputSchema?: Record<string, z.ZodTypeAny>;
  annotations?: Record<string, unknown>;
}

type McpToolHandler = (
  args: Record<string, unknown>
) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

const PROMPT_SNIPPET_MAX = 100;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/** Convert an MCP `inputSchema` (a zod raw shape) to the JSON Schema pi expects
 * for a tool's `parameters`. An empty/absent schema becomes an open object. */
function toParameters(inputSchema: McpToolConfig['inputSchema']): unknown {
  if (!inputSchema || Object.keys(inputSchema).length === 0) {
    return { type: 'object', properties: {} };
  }
  return z.toJSONSchema(z.object(inputSchema));
}

/**
 * A {@link ToolHost} that maps the shared MCP tool registration onto
 * `pi.registerTool` — translating the MCP tool config (description/inputSchema)
 * and result shape into pi's `ToolDefinition` and result. The tool definitions
 * themselves are reused UNCHANGED; only the host binding differs.
 */
export function buildPiHost(pi: PiExtensionAPI): ToolHost {
  const register = ((name: string, config: McpToolConfig, handler: McpToolHandler): unknown => {
    const description = config.description ?? name;
    pi.registerTool({
      name,
      label: name,
      description,
      promptSnippet: truncate(description, PROMPT_SNIPPET_MAX),
      parameters: toParameters(config.inputSchema),
      execute: async (_toolCallId, params) => {
        const result = await handler(params ?? {});
        return {
          content: (result.content ?? []).map((c) => ({ type: 'text', text: c.text })),
          details: undefined,
          isError: result.isError,
        };
      },
    });
    return undefined;
  }) as unknown as ToolHost['registerTool'];
  return { registerTool: register };
}

/** Whether native-tool governance is enabled (`ACCELERATOR_GOVERN_NATIVE`).
 * Default off. */
export function governNative(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test((env.ACCELERATOR_GOVERN_NATIVE ?? '').trim());
}

/** Install the native-tool gate: apply the scope policy to every pi tool call,
 * blocking out-of-scope native (and any other) tool with a `{ block, reason }`.
 * Registration-gated accelerator tools are already absent, so this exists to
 * govern pi's OWN read/grep/find/ls/write/edit/bash. */
export function installNativeGate(pi: PiExtensionAPI, scope: Scope): void {
  pi.on('tool_call', (event) => gateNativeToolCall(event.toolName, scope));
}

/**
 * The pi extension factory. pi calls this with its `ExtensionAPI` when the
 * plugin loads.
 */
export default function installAcceleratorPlugin(pi: PiExtensionAPI): void {
  const scope = scopeFromEnv();
  for (const warning of scope.warnings) {
    process.stderr.write(`@verevoir/accelerator: ${warning}\n`);
  }

  const host = withScope(buildPiHost(pi), scope);
  registerSourceTools(host);
  registerWorkflowTools(host);

  if (governNative()) {
    installNativeGate(pi, scope);
  }
}
