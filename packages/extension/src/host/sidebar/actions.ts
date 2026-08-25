// actions.ts — sidebar command surface (host side).
//
// The three tree providers never call extension code directly: every click
// routes through this injected action bag, keeping providers pure adapters
// while extension.ts owns the real command registrations.
import type { ArchgenModelMessage } from '../../shared/protocol';

export interface SidebarActions {
  openBoard(): void;
  startWork(): void;
  selectFeature(slug: string): void;
  buildTask(taskId: string): void;
  revealTask(taskId: string): void;
  openDoc(relPath: string): void;
}

