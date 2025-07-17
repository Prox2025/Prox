const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');

const VIDEO_URL = process.argv[2];
const START_TIME = process.argv[3] || null;
const END_TIME = process.argv[4] || null;
const DESTINO = process.argv[5] || 'drive';

const SERVER_URL = 'https://livestream.ct.ws/M/upload.php';
const delay = ms => new Promise(r => setTimeout(r, ms));

async function getGoogleDriveCredentials() {
  console.log('🌐 Acessando servidor para obter credenciais...');
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.goto(SERVER_URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await delay(2000);
  const raw = await page.evaluate(() => {
    try { return JSON.parse(document.body.innerText); } catch { return null; }
  });
  await browser.close();

  if (!raw || raw.estado !== 'ok' || !raw.rclone || !raw.pastaDriveId) {
    throw new Error('Credenciais inválidas');
  }

  const chave = {
    client_id: raw.rclone.client_id || raw.rclone['ID do cliente'],
    client_secret: raw.rclone.client_secret,
    refresh_token: raw.rclone.token?.refresh_token || raw.rclone['update_token'],
    token_uri: 'https://oauth2.googleapis.com/token'
  };

  return { chave, pastaDriveId: raw.pastaDriveId };
}

async function getVideoUrlFromFilemoon(url) {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  await delay(5000);
  const iframeUrl = await page.evaluate(() => document.querySelector('iframe')?.src);
  if (!iframeUrl) throw new Error('Iframe não encontrado');
  const frame = await browser.newPage();
  await frame.goto(iframeUrl, { waitUntil: 'networkidle2', timeout: 60000 });
  await delay(4000);
  const videoUrls = await frame.evaluate(() => {
    return new Promise(resolve => {
      const formatos = ['.mp4', '.m3u8'];
      const urls = new Set();
      window.jwplayer = () => ({
        setup: config => {
          if (config.file && formatos.some(f => config.file.includes(f))) urls.add(config.file);
          if (Array.isArray(config.sources)) {
            config.sources.forEach(src => {
              if (src.file && formatos.some(f => src.file.includes(f))) urls.add(src.file);
            });
          }
          resolve(Array.from(urls));
        }
      });
      const scripts = [...document.querySelectorAll('script')].map(s => s.textContent);
      scripts.forEach(code => { if (code.includes('jwplayer')) try { eval(code); } catch {} });
      setTimeout(() => resolve(Array.from(urls)), 3000);
    });
  });
  await browser.close();
  if (videoUrls.length === 0) throw new Error('Nenhuma URL encontrada.');
  return videoUrls[0];
}

function reencode(input, output) {
  const args = ['-i', input];
  if (START_TIME && START_TIME !== '00:00:00') args.push('-ss', START_TIME);
  if (END_TIME && END_TIME !== '00:00:00' && END_TIME !== START_TIME) args.push('-to', END_TIME);
  args.push('-vf', 'scale=-2:240', '-c:v', 'libx264', '-preset', 'fast', '-b:v', '500k', '-c:a', 'aac', '-b:a', '64k', '-y', output);
  const result = spawnSync('ffmpeg', args, { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('Erro ao reencodar vídeo.');
}

async function refreshAccessToken(chave) {
  return new Promise((resolve, reject) => {
    const data = new URLSearchParams({
      client_id: chave.client_id,
      client_secret: chave.client_secret,
      refresh_token: chave.refresh_token,
      grant_type: 'refresh_token'
    }).toString();

    const req = https.request('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': data.length
      }
    }, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (json.access_token) resolve(json.access_token);
          else reject(new Error(`Erro ao obter token: ${body}`));
        } catch { reject(new Error('Erro ao analisar resposta de token')); }
      });
    });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

async function createUploadUrl(nome, token, folderId) {
  const meta = JSON.stringify({ name: nome, parents: [folderId] });
  return new Promise((resolve, reject) => {
    const req = https.request('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'Content-Length': Buffer.byteLength(meta)
      }
    }, res => {
      if (![200, 201].includes(res.statusCode)) reject(new Error('Erro ao criar URL de upload: ' + res.statusCode));
      else resolve(res.headers.location);
    });
    req.on('error', reject);
    req.write(meta); req.end();
  });
}

async function uploadToDrive(filePath, nome, chave, folderId) {
  const CHUNK_SIZE = 256 * 1024 * 1024;
  const size = fs.statSync(filePath).size;
  const fd = fs.openSync(filePath, 'r');
  let offset = 0;
  let token = await refreshAccessToken(chave);
  let uploadUrl = await createUploadUrl(nome, token, folderId);

  while (offset < size) {
    const end = Math.min(offset + CHUNK_SIZE, size) - 1;
    const buffer = Buffer.alloc(end - offset + 1);
    fs.readSync(fd, buffer, 0, buffer.length, offset);

    await new Promise((resolve, reject) => {
      const req = https.request(uploadUrl, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Length': buffer.length,
          'Content-Range': `bytes ${offset}-${end}/${size}`
        }
      }, res => {
        if (![200, 201, 308].includes(res.statusCode)) {
          reject(new Error(`Erro no chunk: ${res.statusCode}`));
        } else {
          resolve();
        }
      });
      req.on('error', reject);
      req.write(buffer); req.end();
    });

    offset = end + 1;
  }

  fs.closeSync(fd);
  console.log('✅ Upload finalizado!');
}

async function baixarVideo(url, outputPath) {
  if (url.includes('youtube.com') || url.includes('youtu.be') || url.includes('facebook.com')) {
    console.log('🎬 Detectado YouTube ou Facebook, baixando com yt-dlp...');
    const result = spawnSync('yt-dlp', ['-o', outputPath, url], { stdio: 'inherit' });
    if (result.status !== 0) throw new Error('Erro ao baixar vídeo com yt-dlp.');
  } else if (url.includes('filemoon')) {
    console.log('🎬 Detectado Filemoon, usando método próprio...');
    const videoUrl = await getVideoUrlFromFilemoon(url);
    console.log('🎯 Link direto do vídeo:', videoUrl);
    const result = spawnSync('ffmpeg', ['-i', videoUrl, '-c', 'copy', '-y', outputPath], { stdio: 'inherit' });
    if (result.status !== 0) throw new Error('Erro ao baixar vídeo do Filemoon.');
  } else {
    throw new Error('Plataforma não suportada.');
  }
}

(async () => {
  try {
    if (!VIDEO_URL) throw new Error('Informe o link do vídeo.');

    const { chave, pastaDriveId } = await getGoogleDriveCredentials();

    const original = path.join(__dirname, 'original.mp4');
    const final = path.join(__dirname, 'final.mp4');

    await baixarVideo(VIDEO_URL, original);

    if (!fs.existsSync(original)) throw new Error('Erro ao baixar vídeo.');

    reencode(original, final);

    if (DESTINO === 'drive') {
      const nome = `video_240p_${Date.now()}.mp4`;
      await uploadToDrive(final, nome, chave, pastaDriveId);
      console.log(`✅ Enviado para Google Drive como: ${nome}`);
    } else {
      console.log('📁 Vídeo salvo localmente como final.mp4');
    }

    fs.unlinkSync(original);
    fs.unlinkSync(final);
  } catch (e) {
    console.error('❌ Erro:', e.message || e);
    process.exit(1);
  }
})();
