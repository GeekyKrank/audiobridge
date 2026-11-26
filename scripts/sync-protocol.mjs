// Copies shared/protocol.js into the extension (which has no build step).
import { copyFileSync } from 'node:fs';
copyFileSync(new URL('../shared/protocol.js', import.meta.url), new URL('../extension/src/lib/protocol.js', import.meta.url));
console.log('Copied shared/protocol.js -> extension/src/lib/protocol.js');
