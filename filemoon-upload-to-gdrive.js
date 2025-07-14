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

const SERVER_URL = 'https://livestream.ct.ws/M/upload.php'; // URL antiga que você usava
const delay = ms => new Promise(r => setTimeout(r, ms));

async function getCredentials() {
  console.log('🌐 Acessando servidor para obter credenciais...');
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.goto(SERVER_URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await delay(3000);
  const json = await page.evaluate(() => {
    try {
      return JSON.parse(document.body.innerText);
    } catch {
      return null;
    }
  });
  await browser.close();

  if (!json || json.estado !== 'ok' || !json.rclone) {
    throw new Error('Credenciais inválidas');
  }

  const rclone = json.rclone;
  if (!rclone.access_token || !rclone.refresh_token) {
    throw new Error('Credenciais incompletas');
  }

  console.log('📦 Credenciais recebidas:', rclone.client_id);
  return { chave: rclone, pastaDriveId: json.pastaDriveId };
}

function isYtOrFb(url) {
  return url.includes('facebook.com') || url.includes('youtube.com') || url.includes('youtu.be');
}

function downloadFromYtOrFb(url, outputPath) {
  console.log('📥 Baixando de YouTube/Facebook...');
  const args = ['-f', 'best[ext=mp4]', url, '-o', outputPath];
  const result = spawnSync('yt-dlp', args, { stdio: 'inherit' });
  if (result.status !== 0) {
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
      if (![200, 201].includes(res.statusCode)) reject(new Error('Erro ao criar URL de upload'));
      else resolve(res.headers.location);
    });
    req.on('error', reject);
    req.write(meta); req.end();
  });
}

async function uploadToDrive(filePath, nome, chave, folderId) {
  const size = fs.statSync(filePath).size;
  const fd = fs.openSync(filePath, 'r');
  let offset = 0;
  let token = chave.access_token;
  let uploadUrl = await createUploadUrl(nome, token, folderId);

  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    try {
      console.log(`📤 Enviando pedaço: ${offset}-${size - 1}/${size} (Tentativa ${tentativa})`);
      const chunkSize = size - offset;
      const buffer = Buffer.alloc(chunkSize);
      fs.readSync(fd, buffer, 0, chunkSize, offset);
      await new Promise((resolve, reject) => {
        const req = https.request(uploadUrl, {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Length': chunkSize,
            'Content-Range': `bytes ${offset}-${offset + chunkSize - 1}/${size}`
          }
        }, res => {
          console.log(`🔍 Resposta do servidor: ${res.statusCode} ${res.statusMessage}`);
          if ([200, 201, 308].includes(res.statusCode)) resolve();
          else reject(new Error(`Erro ao enviar chunk: ${res.statusCode} ${res.statusMessage}`));
        });
        req.on('error', reject);
        req.write(buffer); req.end();
      });
      break;
    } catch (e) {
      console.warn(`⚠️ Falha ao enviar chunk: ${e.message}`);
      if (tentativa < 3) {
        console.log('🔄 Renovando token e URL de upload...');
        await delay(3000);
        token = chave.access_token;
        uploadUrl = await createUploadUrl(nome, token, folderId);
      } else {
        throw new Error('❌ Falha após 3 tentativas de envio do chunk.');
      }
    }
  }

  fs.closeSync(fd);
}

(async () => {
  try {
    if (!VIDEO_URL) throw new Error('Informe o link do vídeo.');

    const { chave, pastaDriveId } = await getCredentials();
    const original = path.join(__dirname, 'original.mp4');
    const final = path.join(__dirname, 'final.mp4');

    if (isYtOrFb(VIDEO_URL)) {
      downloadFromYtOrFb(VIDEO_URL, original);
    } else {
      const videoUrl = await getVideoUrlFromFilemoon(VIDEO_URL);
      console.log('🎯 Link direto do vídeo:', videoUrl);
      spawnSync('ffmpeg', ['-i', videoUrl, '-c', 'copy', '-y', original], { stdio: 'inherit' });
    }

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
