import { execFile } from 'child_process';
import * as path from 'path';

export function playErrorSound(): void {
  // __dirname resolves to out/ at runtime; sounds/ is one level up at extension root
  const soundPath = path.join(__dirname, '..', 'sounds', 'error.mp3');

  if (process.platform === 'darwin') {
    execFile('afplay', [soundPath], { timeout: 10000 }, () => {});
  } else if (process.platform === 'win32') {
    execFile('powershell.exe',
      ['-c', `(New-Object Media.SoundPlayer '${soundPath}').PlaySync()`],
      { timeout: 10000 }, () => {});
  } else {
    execFile('paplay', [soundPath], { timeout: 10000 }, (err) => {
      if (err) {
        execFile('aplay', [soundPath], { timeout: 10000 }, () => {});
      }
    });
  }
}
