// Build the Tauri/wry-based renderer binary.
// Requires Rust toolchain (cargo).
// Supports Windows, macOS, and Linux.

import { existsSync, mkdirSync, copyFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageDir = join(scriptDir, '..');
const tauriDir = join(packageDir, 'tauri');
const binDir = join(packageDir, 'bin');

if (!existsSync(tauriDir)) {
  throw new Error(`Tauri source directory not found: ${tauriDir}`);
}

// Verify cargo is available
const cargoCheck = spawnSync('cargo', ['--version'], { stdio: 'pipe' });
if (cargoCheck.status !== 0) {
  console.error('[pw-user-action] cargo not found — install Rust toolchain to build the dialog binary');
  process.exit(1);
}

// Platform-specific output names
const platform = process.platform;
const exeSuffix = platform === 'win32' ? '.exe' : '';
const cargoBinName = `pw-user-action${exeSuffix}`;
const distBinName = `pw-user-action-renderer${exeSuffix}`;

mkdirSync(binDir, { recursive: true });

console.log(`[pw-user-action] building Tauri/wry renderer for ${platform} (cargo build --release)...`);
const buildResult = spawnSync('cargo', ['build', '--release'], {
  cwd: tauriDir,
  stdio: 'inherit',
});

if (buildResult.status !== 0) {
  process.exit(buildResult.status ?? 1);
}

const builtExe = join(tauriDir, 'target', 'release', cargoBinName);
const outputExe = join(binDir, distBinName);

if (!existsSync(builtExe)) {
  console.error(`[pw-user-action] built binary not found: ${builtExe}`);
  process.exit(1);
}

copyFileSync(builtExe, outputExe);

// Ensure executable bit on unix
if (platform !== 'win32') {
  try {
    const { chmodSync } = await import('fs');
    chmodSync(outputExe, 0o755);
  } catch {}
}

console.log(`[pw-user-action] binary copied to ${outputExe}`);
