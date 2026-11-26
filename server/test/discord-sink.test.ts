import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { Events, type Client } from 'discord.js';
import type { Config } from '../src/config/env.js';
import type { VoiceManager } from '../src/discord/voice.js';
import { DiscordSink } from '../src/stream/discord-sink.js';
import { SinkError } from '../src/stream/types.js';

/** Bare stand-in for discord.js Client: logs in later, knows no guilds. */
function fakeClient() {
  const c = Object.assign(new EventEmitter(), {
    ready: false,
    user: { id: 'bot' },
    guilds: { cache: new Map() },
    isReady() {
      return this.ready;
    },
  });
  return c;
}

const config = { discordGuildId: 'g1', maxBufferMs: 1500, allowedUserIds: new Set() } as unknown as Config;
const voice = { getSession: () => null } as unknown as VoiceManager;

test('start right after a restart waits for the Discord login instead of refusing', async () => {
  const client = fakeClient();
  const sink = new DiscordSink(client as unknown as Client, voice, config);
  setTimeout(() => {
    client.ready = true;
    client.emit(Events.ClientReady, client);
  }, 50);
  // Past the readiness wait it reaches the guild lookup: NO_GUILD, not BOT_OFFLINE.
  await assert.rejects(
    sink.begin({ bufferMs: 400 } as never),
    (e: unknown) => e instanceof SinkError && e.code === 'NO_GUILD',
  );
  assert.equal(client.listenerCount(Events.ClientReady), 0);
});
