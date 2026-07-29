import { EventEmitter } from 'node:events';

/**
 * Progress events emitted by the bot and streamed to the dashboard
 * via Server-Sent Events.
 */
export interface BotEvent {
  type: 'scan_start' | 'scan_progress' | 'scan_done'
       | 'verify_start' | 'verify_progress'
       | 'enter_start' | 'enter_progress' | 'enter_done'
       | 'info';
  /** Human-readable message shown in the activity feed. */
  message: string;
  /** Optional detail payload. */
  detail?: Record<string, unknown>;
  timestamp: string;
}

type Listener = (event: BotEvent) => void;

class BotEventBus {
  private ee = new EventEmitter();

  emit(event: Omit<BotEvent, 'timestamp'>): void {
    this.ee.emit('event', { ...event, timestamp: new Date().toISOString() });
  }

  /** Scan helpers */
  scanStart(pageName: string) {
    this.emit({ type: 'scan_start', message: `🔍 Scanning "${pageName}"...` });
  }
  scanProgress(pageName: string, found: number) {
    this.emit({ type: 'scan_progress', message: `  📋 ${pageName}: found ${found} competition${found !== 1 ? 's' : ''}`, detail: { pageName, found } });
  }
  scanDone(pagesCount: number) {
    this.emit({ type: 'scan_done', message: `✅ Scan complete — ${pagesCount} page${pagesCount !== 1 ? 's' : ''} checked` });
  }

  /** Verify helpers */
  verifyStart(pageName: string) {
    this.emit({ type: 'verify_start', message: `🤖 LLM verifying "${pageName}"...` });
  }
  verifyProgress(pageName: string, approved: number, total: number) {
    this.emit({ type: 'verify_progress', message: `  🤖 ${pageName}: ${approved}/${total} links confirmed as competitions`, detail: { pageName, approved, total } });
  }

  /** Enter helpers */
  enterStart(title: string) {
    this.emit({ type: 'enter_start', message: `🎯 Entering "${title}"...` });
  }
  enterDone(title: string, success: boolean, detail?: string) {
    const icon = success ? '✅' : '❌';
    const msg = detail || (success ? 'Entered successfully' : 'Failed');
    this.emit({ type: 'enter_done', message: `  ${icon} "${title}" — ${msg}`, detail: { title, success } });
  }

  /** Generic info */
  info(msg: string) {
    this.emit({ type: 'info', message: msg });
  }

  /** Subscribe to all events. Returns an unsubscribe function. */
  subscribe(listener: Listener): () => void {
    this.ee.on('event', listener);
    return () => { this.ee.off('event', listener); };
  }
}

export const botEvents = new BotEventBus();
