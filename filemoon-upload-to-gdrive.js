const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const VIDEO_URL = process.argv[2];
const START_TIME = process.argv[3] || null;
const END_TIME = process.argv[4] || null;
const DESTINO = process.argv[5] || 'drive';

const SERVER_URL = 'https://livestream.ct.ws/M/upload.php';
const delay = ms => new Promise(r => setTimeout(r, ms));

// Obtém as credenciais e pasta do servidor
async function getGoogleDriveCredentials() {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.goto(SERVER_URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await delay(3000);
  const json = await page.evaluate(() => {
    try { return JSON.parse(document.body.innerText); } catch { return null; }
  });
  await browser.close();
  if (!json || !json.chave || !json.pastaDriveId) throw new Error('Credenciais inválidas');
  return json;
}

function isYtOrFb(url) {
  return url.includes('facebook.com') || url.includes('youtube.com') || url.includes('youtu.be');
}

function downloadFromYtOrFb(url, outputPath) {
  console.log('📥 Baixando de YouTube/Facebook...');
  const args = ['-f', 'best[ext=mp4]', url, '-o', outputPath];
  const result = spawnSync('yt-dlp', args, { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error('🔍 yt-dlp falhou. Verifique se o vídeo é público.');
    throw new Error('Erro no yt-dlp');
  }
}

async function getVideoUrlFromFilemoon(url) {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  await delay(7000);
  const iframeUrl = await page.evaluate(() => document.querySelector('iframe')?.src);
  if (!iframeUrl) throw new Error('Iframe não encontrado');
  const frame = await browser.newPage();
  await frame.goto(iframeUrl, { waitUntil: 'networkidle2', timeout: 60000 });
  await delay(5000);
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

async function generateGoogleDriveToken(chave) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const claim = Buffer.from(JSON.stringify({
    iss: chave.client_email,
    scope: 'https://www.googleapis.com/auth/drive.file',
    aud: chave.token_uri,
    exp: now + 3600,
    iat: now
  })).toString('base64url');
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  const signature = signer.sign(chave.private_key, 'base64url');
  const jwt = `${header}.${claim}.${signature}`;
  return new Promise((resolve, reject) => {
    const data = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    }).toString();
    const req = https.request(chave.token_uri, {
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
          else reject(new Error(body));
        } catch { reject(new Error('Erro ao gerar token')); }
      });
    });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

function reencode(input, output) {
  const args = ['-i', input];
  if (START_TIME && START_TIME !== '00:00:00') args.push('-ss', START_TIME);
  if (END_TIME && END_TIME !== '00:00:00' && END_TIME !== START_TIME) args.push('-to', END_TIME);
  args.push(
    '-vf', 'scale=-2:240',
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-b:v', '500k',
    '-c:a', 'aac',
    '-b:a', '64k',
    '-y',
    output
  );
  const result = spawnSync('ffmpeg', args, { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('Erro ao reencodar vídeo.');
}

// NOVA função para gerar a URL de upload
async function criarUploadUrl(token, nome, folderId) {
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
      if (![200, 201].includes(res.statusCode)) {
        reject(new Error(`Erro ao iniciar upload resumido. Status: ${res.statusCode}`));
      } else {
        resolve(res.headers.location);
      }
    });
    req.on('error', reject);
    req.write(meta); req.end();
  });
}

async function uploadToDrive(filePath, nome, token, folderId, chave) {
  let tokenAtual = token;
  let uploadUrl = await criarUploadUrl(tokenAtual, nome, folderId);

  const CHUNK = 256 * 1024 * 1024;
  const size = fs.statSync(filePath).size;
  const fd = fs.openSync(filePath, 'r');
  let offset = 0;

  while (offset < size) {
    const chunkSize = Math.min(CHUNK, size - offset);
    const buffer = Buffer.alloc(chunkSize);
    fs.readSync(fd, buffer, 0, chunkSize, offset);

    let success = false;
    let attempts = 0;

    while (!success && attempts < 3) {
      try {
        console.log(`📤 Enviando pedaço: ${offset}-${offset + chunkSize - 1}/${size} (Tentativa ${attempts + 1})`);

        await new Promise((resolve, reject) => {
          const req = https.request(uploadUrl, {
            method: 'PUT',
            headers: {
              'Authorization': `Bearer ${tokenAtual}`,
              'Content-Length': chunkSize,
              'Content-Range': `bytes ${offset}-${offset + chunkSize - 1}/${size}`
            }
          }, res => {
            if ([200, 201, 308].includes(res.statusCode)) resolve();
            else if ([401, 403].includes(res.statusCode)) {
              reject(new Error(`Token expirado ou inválido (HTTP ${res.statusCode})`));
            } else {
              reject(new Error(`Erro HTTP ${res.statusCode}`));
            }
          });
          req.on('error', reject);
          req.write(buffer); req.end();
        });

        success = true;
      } catch (err) {
        console.warn(`⚠️ Falha ao enviar chunk: ${err.message}`);
        attempts++;
        if (err.message.includes('Token expirado') && attempts < 3) {
          console.log('🔄 Renovando token e URL...');
          tokenAtual = await generateGoogleDriveToken(chave);
          uploadUrl = await criarUploadUrl(tokenAtual, nome, folderId);
        }
        if (attempts >= 3) throw new Error('Erro ao enviar chunk após 3 tentativas.');
        await delay(2000);
      }
    }

    offset += chunkSize;
  }

  fs.closeSync(fd);
}

// EXECUÇÃO PRINCIPAL
(async () => {
  try {
    if (!VIDEO_URL) throw new Error('Informe o link do vídeo.');

    const { chave, pastaDriveId } = await getGoogleDriveCredentials();

    const original = path.join(__dirname, 'original.mp4');
    const final = path.join(__dirname, 'final.mp4');

    if (isYtOrFb(VIDEO_URL)) {
      downloadFromYtOrFb(VIDEO_URL, original);
    } else {
      const videoUrl = await getVideoUrlFromFilemoon(VIDEO_URL);
      spawnSync('ffmpeg', ['-i', videoUrl, '-c:v', 'libx264', '-c:a', 'aac', '-y', original], { stdio: 'inherit' });
    }

    if (!fs.existsSync(original)) throw new Error('Erro ao baixar vídeo.');

    reencode(original, final);

    if (DESTINO === 'drive') {
      let token = await generateGoogleDriveToken(chave);
      await uploadToDrive(final, `video_240p_${Date.now()}.mp4`, token, pastaDriveId, chave);
      console.log('✅ Enviado ao Google Drive com sucesso!');
    } else {
      console.log('📁 Vídeo processado salvo localmente como final.mp4');
    }

    if (fs.existsSync(original)) fs.unlinkSync(original);
    if (fs.existsSync(final)) fs.unlinkSync(final);
  } catch (e) {
    console.error('❌ Erro:', e.message || e);
  }
})();
