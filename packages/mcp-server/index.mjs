#!/usr/bin/env node
// MCP adapter for the Sentiora runtime (issue #4, M4 slice 3).
//
// The point of this package is that it adds no protocol of its own: it is a thin mapping from MCP
// tool calls onto the JSON-RPC the runtime already speaks, through the same `agent-client` the
// tests use. Nothing here reaches into src/.
//
// The one design decision worth stating: **the model never sees a capability token.** The owner
// token stays in this process, keyed by session id; a tool returns the id and nothing else. A
// model that could read the owner token could type into a session it was only meant to watch, and
// the mailbox capability would be equally exposed. So the tools are the authority boundary, and
// `terminal_observe` is deliberately read-only.
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { AgentClient } from '../agent-client/index.mjs';

const SERVER_PATH = process.env.SENTIORA_SERVER
  ?? fileURLToPath(new URL('../../src/server.js', import.meta.url));
const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'sentiora-terminal', version: '0.1.0' };

let client = null;
/** sessionId -> AgentSession. Holds the owner tokens; never serialised into a tool result. */
const sessions = new Map();

const TOOLS = [
  {
    name: 'terminal_create',
    description: 'Start a program in a real PTY and return a session id. The shell sees a terminal, not a pipe.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Absolute path or PATH name of the program to run.' },
        args: { type: 'array', items: { type: 'string' }, description: 'Arguments, one array entry each.' },
        cols: { type: 'number', description: 'Columns (default 120).' },
        rows: { type: 'number', description: 'Rows (default 40).' },
        cwd: { type: 'string', description: 'Working directory (default: the runtime process cwd).' },
      },
      required: ['command'],
    },
  },
  {
    name: 'terminal_type',
    description: 'Type text into a session. The runtime is revision-guarded; this tool retries a stale revision for you.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        text: { type: 'string', description: 'Text to send. Include \\r yourself, or use terminal_line.' },
      },
      required: ['sessionId', 'text'],
    },
  },
  {
    name: 'terminal_line',
    description: 'Type a line into a session and press Enter.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        line: { type: 'string' },
      },
      required: ['sessionId', 'line'],
    },
  },
  {
    name: 'terminal_observe',
    description: 'Read a session: the rendered screen, its state, pid, revision and exit record. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { sessionId: { type: 'string' } },
      required: ['sessionId'],
    },
  },
  {
    name: 'terminal_list',
    description: 'List open sessions with their observations. Never includes capability tokens.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'terminal_close',
    description: 'Close a session and free its slot.',
    inputSchema: {
      type: 'object',
      properties: { sessionId: { type: 'string' } },
      required: ['sessionId'],
    },
  },
];

async function runtime() {
  if (!client) client = await AgentClient.connect({ serverPath: SERVER_PATH });
  return client;
}

function requireSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Unknown session: ${sessionId}`);
  return session;
}

/** The observation as a tool result: the screen plus the objective state, and never a token. */
function describe(observation) {
  return {
    sessionId: observation.sessionId,
    state: observation.state,
    pid: observation.pid,
    revision: observation.revision,
    running: observation.running,
    exit: observation.exit ?? null,
    cols: observation.cols,
    rows: observation.rows,
    screen: observation.screen,
  };
}

async function callTool(name, args = {}) {
  const api = await runtime();
  switch (name) {
    case 'terminal_create': {
      const session = await api.create({
        command: args.command,
        args: args.args ?? [],
        cols: args.cols,
        rows: args.rows,
        cwd: args.cwd,
      });
      sessions.set(session.sessionId, session);
      const observation = await api.observe(session);
      return { sessionId: session.sessionId, pid: observation.pid, state: observation.state };
    }
    case 'terminal_type':
      await api.sendText(requireSession(args.sessionId), args.text);
      return { sessionId: args.sessionId, typed: args.text.length };
    case 'terminal_line':
      await api.sendLine(requireSession(args.sessionId), args.line);
      return { sessionId: args.sessionId, typed: args.line.length + 1 };
    case 'terminal_observe':
      return describe(await api.observe(requireSession(args.sessionId)));
    case 'terminal_list':
      return { sessions: (await api.list()).map(describe) };
    case 'terminal_close': {
      const session = requireSession(args.sessionId);
      await api.close(session);
      sessions.delete(args.sessionId);
      return { sessionId: args.sessionId, closed: true };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function reply(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handle(request) {
  const { id, method, params } = request;
  // A notification has no id and must not be answered, including unknown ones.
  if (method === 'notifications/initialized' || method === 'initialized') return;
  if (method === 'initialize') {
    return reply({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      },
    });
  }
  if (method === 'ping') return reply({ jsonrpc: '2.0', id, result: {} });
  if (method === 'tools/list') return reply({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  if (method === 'tools/call') {
    const name = params?.name;
    try {
      const result = await callTool(name, params?.arguments ?? {});
      return reply({
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] },
      });
    } catch (error) {
      // A tool failure is a result with isError, not a protocol error: the model has to see it and
      // react, which a JSON-RPC error would prevent in some clients.
      return reply({
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: String(error?.message ?? error) }], isError: true },
      });
    }
  }
  if (id === undefined || id === null) return;
  return reply({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${method}` } });
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', line => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return reply({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  handle(request).catch(error => {
    if (request?.id !== undefined && request?.id !== null) {
      reply({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: String(error?.message ?? error) } });
    }
  });
});

// The runtime is a child process of this adapter; leaving it behind on stdin close would keep the
// PTYs alive after the client that asked for them is gone.
rl.on('close', async () => {
  try { await client?.dispose(); } catch { /* already gone */ }
  process.exit(0);
});
