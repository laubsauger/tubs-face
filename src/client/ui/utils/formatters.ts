import type { HealthResponse } from '../../../shared/contracts/http.js';
import type { ChatEntry } from '../../state/app-state.js';
import type { TurnActor } from '../../../shared/contracts/turn-script.js';

export function formatCurrency(amount: number | null | undefined): string {
  if (amount == null) return '$0.00';
  return '$' + amount.toFixed(4);
}

export function formatUptime(health: HealthResponse | null): string {
  if (!health || health.uptime == null) return 'offline';
  const sec = health.uptime;
  if (sec < 60) return `${Math.floor(sec)}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${Math.floor(sec % 60)}s`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

export function formatAwakeElapsed(sec: number): string {
  if (sec === 0) return '0s';
  if (sec < 60) return `${Math.floor(sec)}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${Math.floor(sec % 60)}s`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

export function formatTimestamp(ts: number | undefined): string {
  if (!ts) return '';
  const date = new Date(ts);
  return date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

export function renderChatPrefix(type: string, actor: string | undefined): string {
  if (type === 'sys') return '[system]';
  return actor ?? 'unknown';
}

export function resolveChatActor(entry: ChatEntry): 'user' | 'system' | 'main' | 'small' | 'ambiguous' {
  if (entry.type === 'sys') return 'system';
  if (entry.actor === 'user' || entry.actor === 'system' || entry.actor === 'main' || entry.actor === 'small') {
    return entry.actor;
  }
  return 'ambiguous';
}

export function isChatEntryVisible(verbosity: 'all' | 'chat' | 'minimal', type: ChatEntry['type']): boolean {
  if (verbosity === 'all') return true;
  if (verbosity === 'minimal' && type === 'sys') return false;
  return true;
}
