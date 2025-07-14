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

const UPLOAD_PHP_URL = 'https://livestream.ct.ws/M/upload.php'; // URL para pegar credenciais

const delay = ms => new Promise(r => setTimeout(r, ms));

// Obtem credenciais do servidor (PHP)
async function getCredentials() {
  console.log('🌐 Acessando servidor para obter credenciais...');
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.goto(UPLOAD_PHP_URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await delay(2000);

  const data = await page.evaluate(() => {
    try { return JSON.parse(document.body.innerText); } catch { return null; }
  });

  await browser.close();

  if (!data || data.estado !== 'ok' || !data.rclone || !data.pastaDriveId) {
    throw new Error('Credenciais inválidas');
  }

  // Normaliza as chaves do token para inglês e sem espaços
  const rclone = data.rclone;
  const token = rclone.token || {};

  const chaveNormalizada = {
    client_id: rclone['ID do cliente'] || rclone.client_id || '',
    client_secret: rclone.client_secret || '',
    scope: rclone.escopo || rclone.scope || '',
    token: {
      access_token: token['token de acesso'] || token.access_token || '',
      token_type: token['tipo de token'] || token.token_type || '',
      refresh_token: token['update_token'] || token.refresh_token || '',
      expiry: token.validade || token.expiry || '',
      expires_in: token.expira_em || token.expires_in || 0,
    }
  };

  console.log('📦 Dados recebidos do servidor (normalizados):', {
    chave: chaveNormalizada,
    pastaDriveId: data.pastaDriveId
  });

  return {
    chave: chaveNormalizada,
    pastaDriveId: data.pastaDriveId
  };
}

// Renova o access_token usando o refresh_token
function refreshAccessToken(client_id, client_secret, refresh_token) {
  return new Promise((resolve, reject) => {
    const postData = new URLSearchParams({
      client_id,
      client_secret,
      refresh_token,
      grant_type: 'refresh_token'
    }).toString();

    const options = {
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.access_token) {
            resolve(json.access_token);
          } else {
            reject(new Error('Falha ao renovar token: ' + data));
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
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
      if (![200, 201].includes(res.statusCode)) reject(new Error('Erro ao criar URL de upload: ' + res.statusCode));
      else resolve(res.headers.location);
    });
    req.on('error', reject);
    req.write(meta); req.end();
  });
}

async function uploadChunk(uploadUrl, token, buffer, start, end, total) {
  return new Promise((resolve, reject) => {
    const req = https.request(uploadUrl, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Length': buffer.length,
        'Content-Range': `bytes ${start}-${end}/${total}`
      }
    }, res => {
      if ([200, 201, 308].includes(res.statusCode)) resolve();
      else reject(new Error(`Erro ao enviar chunk: ${res.statusCode}`));
    });
    req.on('error', reject);
    req.write(buffer);
    req.end();
  });
}

async function uploadToDrive(filePath, nome, chave, folderId) {
  const CHUNK = 256 * 1024 * 1024;
  const size = fs.statSync(filePath).size;
  const fd = fs.openSync(filePath, 'r');
  let offset = 0;
  let token = chave.token.access_token;

  let uploadUrl = await createUploadUrl(nome, token, folderId);

  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    try {
      while (offset < size) {
        const chunkSize = Math.min(CHUNK, size - offset);
        const buffer = Buffer.alloc(chunkSize);
        fs.readSync(fd, buffer, 0, chunkSize, offset);

        await uploadChunk(uploadUrl, token, buffer, offset, offset + chunkSize - 1, size);

        offset += chunkSize;
        console.log(`📤 Enviado chunk: ${offset}/${size}`);
      }
      break; // upload concluído com sucesso
    } catch (e) {
      console.warn(`⚠️ Falha no upload: ${e.message}`);
      if (tentativa < 3) {
        console.log('🔄 Tentando renovar token e reiniciar upload...');
        token = await refreshAccessToken(chave.client_id, chave.client_secret, chave.token.refresh_token);
        uploadUrl = await createUploadUrl(nome, token, folderId);
        offset = 0; // reinicia o upload do início
        await delay(2000);
      } else {
        fs.closeSync(fd);
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
