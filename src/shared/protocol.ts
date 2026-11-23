import type { Snapshot } from './game.js';
import type { WordError } from './text.js';

export type ClientMsg =
  | {
      t: 'hello';
      room: string;
      accessToken?: string;
      guest?: { id: string; name: string };
      /** Voice channel of the Activity (server verifies it with Discord when it can). */
      channelId?: string;
      guildId?: string;
    }
  | { t: 'start' }
  | { t: 'settings'; turnSeconds: number }
  | { t: 'pick'; letter: string }
  | { t: 'word'; text: string }
  | { t: 'typing'; text: string }
  | { t: 'lobby' }
  | { t: 'surrender' };

export type ServerMsg =
  | { t: 'welcome'; you: string }
  | { t: 'state'; s: Snapshot }
  | { t: 'typing'; by: string; text: string }
  | { t: 'reject'; error: WordError | 'not_your_turn' | 'slow_down'; word: string }
  | { t: 'fatal'; reason: 'auth' | 'bad_hello' };
