import { help } from './help.js';
import { join } from './join.js';
import { leave } from './leave.js';
import { status } from './status.js';
import { stop } from './stop.js';
import type { Command } from './types.js';

export const commands: readonly Command[] = [join, leave, stop, status, help];
export const commandMap = new Map(commands.map((c) => [c.data.name, c]));
export type { Command, CommandContext } from './types.js';
