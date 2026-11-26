import type {
  ChatInputCommandInteraction,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';
import type { Config } from '../../config/env.js';
import type { StreamHub } from '../../stream/hub.js';
import type { VoiceManager } from '../voice.js';

export interface CommandContext {
  config: Config;
  voice: VoiceManager;
  hub: StreamHub;
}

export interface Command {
  data: { name: string; toJSON(): RESTPostAPIChatInputApplicationCommandsJSONBody };
  execute(interaction: ChatInputCommandInteraction<'cached'>, ctx: CommandContext): Promise<void>;
}
