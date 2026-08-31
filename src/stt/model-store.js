'use strict';

// Downloads and unpacks the speech-to-text models into the user's data
// directory. Models are not bundled in the installer: the Parakeet archive is
// ~460 MB compressed, which would make the DMG/NSIS artifacts impractical.

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFile } = require('child_process');

const RELEASE_BASE =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models';

// Every entry is a self-contained unit that `ensureAsset` can install.
// `kind: 'archive'` is downloaded to a temp file and unpacked with tar;
// `kind: 'file'` is written straight to its destination.
const ASSETS = {
  'silero-vad': {
    kind: 'file',
    label: 'Silero VAD',
    url: `${RELEASE_BASE}/silero_vad.onnx`,
    // Model file, not an archive, so the directory is shared with other VADs.
    dir: 'vad',
    fileName: 'silero_vad.onnx',
    approxBytes: 643_854,
  },
  'parakeet-tdt-0.6b-v2': {
    kind: 'archive',
    label: 'NVIDIA Parakeet TDT 0.6B v2 (int8)',
    url: `${RELEASE_BASE}/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2`,
    // The tarball already contains this directory at its root, so it is
    // extracted into the parent and lands here.
    dir: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8',
    // Compressed download size; the server also reports it, so this is only a
    // fallback for the progress readout and the size shown in Settings.
    approxBytes: 482_468_385,
    expects: [
      'encoder.int8.onnx',
      'decoder.int8.onnx',
      'joiner.int8.onnx',
      'tokens.txt',
    ],
  },
};

let modelsRoot = null;

function setModelsRoot(dir) {
  modelsRoot = dir;
  fs.mkdirSync(modelsRoot, { recursive: true });
}

function requireRoot() {
  if (!modelsRoot) throw new Error('Model store was used before setModelsRoot().');
  return modelsRoot;
}

function assetDir(id) {
  const asset = ASSETS[id];
  if (!asset) throw new Error(`Unknown model asset: ${id}`);
  return path.join(requireRoot(), asset.dir);
}

function assetPaths(id) {
  const asset = ASSETS[id];
  const dir = assetDir(id);
  if (asset.kind === 'file') {
    return { dir, file: path.join(dir, asset.fileName) };
  }
  const files = {};
  for (const name of asset.expects) files[name] = path.join(dir, name);
  return { dir, files };
}

// A partially extracted archive is worse than a missing one: sherpa-onnx would
// fail deep inside the native addon. Require every expected member.
function isInstalled(id) {
  const asset = ASSETS[id];
  if (!asset) return false;
  try {
    const dir = assetDir(id);
    if (asset.kind === 'file') {
      return fs.statSync(path.join(dir, asset.fileName)).size > 0;
    }
    return asset.expects.every(name => fs.statSync(path.join(dir, name)).size > 0);
  } catch (_) {
    return false;
  }
}

function status() {
  const out = {};
  for (const id of Object.keys(ASSETS)) {
    out[id] = {
      label: ASSETS[id].label,
      installed: isInstalled(id),
      approxBytes: ASSETS[id].approxBytes,
    };
  }
  return out;
}

// GitHub release downloads redirect to a CDN host, so redirects have to be
// followed manually — `https.get` does not do it.
function download(url, destFile, onProgress, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      { headers: { 'User-Agent': 'ghost-stt' } },
      (response) => {
        const { statusCode, headers } = response;

        if (statusCode >= 300 && statusCode < 400 && headers.location) {
          response.resume();
          if (redirectsLeft === 0) {
            reject(new Error('Too many redirects while downloading the model.'));
            return;
          }
          const next = new URL(headers.location, url).toString();
          download(next, destFile, onProgress, redirectsLeft - 1).then(resolve, reject);
          return;
        }

        if (statusCode !== 200) {
          response.resume();
          reject(new Error(`Model download failed with HTTP ${statusCode}.`));
          return;
        }

        const total = Number(headers['content-length']) || 0;
        let received = 0;
        const out = fs.createWriteStream(destFile);

        response.on('data', (chunk) => {
          received += chunk.length;
          onProgress(received, total);
        });
        response.pipe(out);

        out.on('error', reject);
        out.on('finish', () => out.close(() => resolve()));
        response.on('error', reject);
      },
    );
    request.on('error', reject);
    // A stalled connection would otherwise hang the download forever.
    request.setTimeout(120_000, () => request.destroy(new Error('Model download timed out.')));
  });
}

// bzip2 has no Node core decompressor. Both bsdtar (macOS, Windows 10 1803+)
// and GNU tar handle `-xj`, so shelling out avoids an extra dependency.
function extractTarBz2(archiveFile, intoDir) {
  return new Promise((resolve, reject) => {
    execFile(
      'tar',
      ['-xjf', archiveFile, '-C', intoDir],
      { maxBuffer: 8 * 1024 * 1024 },
      (err, _stdout, stderr) => {
        if (err) {
          reject(new Error(`Could not unpack the model archive: ${stderr || err.message}`));
          return;
        }
        resolve();
      },
    );
  });
}

/**
 * Installs an asset if it is not already present.
 * @param {string} id key of ASSETS
 * @param {(p: {id: string, phase: string, received: number, total: number}) => void} onProgress
 */
async function ensureAsset(id, onProgress = () => {}) {
  const asset = ASSETS[id];
  if (!asset) throw new Error(`Unknown model asset: ${id}`);
  if (isInstalled(id)) return assetPaths(id);

  const root = requireRoot();
  const report = (phase, received = 0, total = asset.approxBytes) =>
    onProgress({ id, label: asset.label, phase, received, total });

  if (asset.kind === 'file') {
    const dir = assetDir(id);
    fs.mkdirSync(dir, { recursive: true });
    const finalFile = path.join(dir, asset.fileName);
    const tempFile = `${finalFile}.part`;
    report('downloading');
    await download(asset.url, tempFile, (received, total) =>
      report('downloading', received, total || asset.approxBytes));
    fs.renameSync(tempFile, finalFile);
    report('ready', asset.approxBytes, asset.approxBytes);
    return assetPaths(id);
  }

  const tempArchive = path.join(root, `${id}.tar.bz2.part`);
  try {
    report('downloading');
    await download(asset.url, tempArchive, (received, total) =>
      report('downloading', received, total || asset.approxBytes));

    report('extracting', asset.approxBytes, asset.approxBytes);
    await extractTarBz2(tempArchive, root);

    if (!isInstalled(id)) {
      throw new Error('The model archive unpacked but expected files are missing.');
    }
    report('ready', asset.approxBytes, asset.approxBytes);
    return assetPaths(id);
  } finally {
    try { fs.unlinkSync(tempArchive); } catch (_) {}
  }
}

module.exports = {
  ASSETS,
  setModelsRoot,
  assetPaths,
  isInstalled,
  status,
  ensureAsset,
};
