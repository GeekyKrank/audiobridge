/**
 * Registers the slash commands with Discord for your server only (guild commands
 * update instantly; global commands can take up to an hour).
 * Run again whenever a command's name, description or options change.
 */
import { REST, Routes } from 'discord.js';
import { loadConfig } from '../src/config/env.js';
import { commands } from '../src/discord/commands/index.js';

const body = commands.map((c) => c.data.toJSON());

try {
  const config = loadConfig();
  const rest = new REST().setToken(config.discordToken);
  const result = (await rest.put(
    Routes.applicationGuildCommands(config.discordClientId, config.discordGuildId),
    { body },
  )) as unknown[];
  console.log(`Registered ${result.length} slash commands in guild ${config.discordGuildId}:`);
  for (const c of body) console.log(`  /${c.name} — ${c.description}`);
} catch (err) {
  console.error('Failed to register commands:', err instanceof Error ? err.message : err);
  process.exit(1);
}
