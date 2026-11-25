// Wire types for the loopback API in apps/desktop/server/ipc.js.
// The server is authoritative; if these disagree with it, the server wins.

export type LifecycleState = 'spawned' | 'operational' | 'exited' | 'released';

export interface ExitInfo {
  exitCode: number;
  signal: number | null;
}

export interface ShellProbe {
  command: string;
  expect: string;
}

export interface Shell {
  id: string;
  label: string;
  family: string;
  command: string;
  args: string[];
  cwd: string | null;
  promptPattern: string | null;
  probe: ShellProbe;
  available: boolean;
  custom?: boolean;
}

export interface SessionDescriptor {
  sessionId: string;
  hostId: string;
  label: string;
  command: { command: string; args: string[] };
  shellId: string | null;
  promptPattern: string | null;
  state: LifecycleState;
  revision: number;
  cols: number;
  rows: number;
  writeErrors: number;
  exit: ExitInfo | null;
  backendLost: string | null;
  scrollbackLines: number;
  subscribers: number;
}

export interface Observation {
  sessionId: string;
  pid: number | null;
  state: LifecycleState;
  revision: number;
  running: boolean;
  exit: ExitInfo | null;
  cols: number;
  rows: number;
  writeErrors: number;
  cursor: { x: number; y: number };
  screen: string;
  idleMilliseconds: number;
}

/** A whole rendered viewport. The runtime exposes no byte stream, so this is the unit of output. */
export interface Frame {
  kind: 'snapshot' | 'frame' | 'lost';
  sessionId: string;
  revision: number;
  state: LifecycleState;
  exit: ExitInfo | null;
  cols: number;
  rows: number;
  writeErrors: number;
  backendLost: string | null;
  cursor: { x: number; y: number };
  /** Repaint every row rather than diffing: set on the first frame after a gap. */
  resync: boolean;
  /** How many intermediate frames were folded into this one by backpressure. */
  coalesced?: number;
  /** Lines that left the top of the viewport, recovered by the bridge. */
  scrolledOff: string[];
  lines: string[];
  scrollbackLength: number;
  /** Present on the initial snapshot only. */
  scrollback?: string[];
  describe?: SessionDescriptor;
}

export interface HostInfo {
  id: string;
  active: number;
  draining: boolean;
  full: boolean;
  dead: boolean;
  lifetimeSessions: number;
  alive: boolean;
}

export interface RuntimeInfo {
  protocolVersion: number;
  platform: string;
  arch: string;
  conptyDll: boolean;
  fake?: boolean;
}

export interface Info {
  product: string;
  milestone: string;
  outputMode: 'snapshot';
  outputModes: string[];
  hosts: HostInfo[];
  runtime: RuntimeInfo | null;
  limits: { sessionLimitPerHost: number; recycleAfterSessions: number; maxHosts: number };
  animationEvents: string[];
}

export interface Settings {
  schemaVersion: number;
  appearance: {
    themeSource: 'system' | 'light' | 'dark';
    fontSize: number;
    fontFamily: string;
    lineHeight: number;
    cursorBlink: boolean;
    scrollbackLines: number;
  };
  animation: {
    preset: 'professional' | 'living' | 'immersive';
    enabled: boolean;
    intensity: number;
    respectSystemReducedMotion: boolean;
    layers: { mascot: boolean; particles: boolean; transitions: boolean };
  };
  shell: { id: string; command: string | null; args: string[]; cwd: string | null };
  layout: {
    restoreTabs: boolean;
    tabs: Array<{ id: string; title: string; shellId: string; splitDirection: 'horizontal' | 'vertical' }>;
  };
  onboarding: { completed: boolean };
}

export interface ResolvedAnimation {
  preset: string;
  effectivePreset: string;
  reason: 'enabled' | 'disabled' | 'system-reduced-motion';
  enabled: boolean;
  intensity: number;
  mascot: boolean;
  particles: boolean;
  transitions: boolean;
}

export interface ApiErrorBody {
  error: string;
  kind?: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly kind: string;

  constructor(status: number, kind: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.kind = kind;
  }
}
