const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const VIDEO_URL_RAW = process.argv[2];
const START_TIME = process.argv[3] || null;
const END_TIME = process.argv[4] || null;
const DESTINO = process.argv[5] || 'drive';

const SERVER_URL = 'https://livestream.ct.ws/M/upload.php';
const delay = ms => new Promise(r => setTimeout(r, ms));

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

function normalizeUrl(url) {
  if (!url) return url;
  return url.replace('m.youtube.com', 'www.youtube.com');
}

function isYtOrFb(url) {
  return url.includes('facebook.com') || url.includes('youtube.com') || url.includes('youtu.be');
}

function downloadFromYtOrFb(url, outputPath) {
  console.log('📥 Baixando de YouTube/Facebook...');
  const args = ['-f', 'best[ext=mp4]', url, '-o', outputPath];
  const result = spawnSync('yt-dlp', args, { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error('🔍 yt-dlp falhou. Verifique se o vídeo é público ou se os cookies estão corretos.');
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
  // Só adiciona corte se definido e diferente de '00:00:00' e start != end
  if (START_TIME && START_TIME !== '00:00:00' && END_TIME && END_TIME !== '00:00:00' && START_TIME !== END_TIME) {
    args.push('-ss', START_TIME, '-to', END_TIME);
  }
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

async function uploadToDrive(filePath, nome, chave, pastaDriveId) {
  let token = await generateGoogleDriveToken(chave);

  async function getUploadUrl() {
    const meta = JSON.stringify({ name: nome, parents: [pastaDriveId] });
    return new Promise((resolve, reject) => {
      const req = https.request('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json; charset=UTF-8',
          'Content-Length': Buffer.byteLength(meta),
        }
      }, res => {
        if ([200, 201].includes(res.statusCode)) {
          resolve(res.headers.location);
        } else {
          reject(new Error(`Erro no upload resumido: ${res.statusCode}`));
        }
      });
      req.on('error', reject);
      req.write(meta);
      req.end();
    });
  }

  async function getFileMetadata(fileId) {
    return new Promise((resolve, reject) => {
      const req = https.request(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,mimeType,size,parents,webViewLink`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
        }
      }, res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if ([200, 201].includes(res.statusCode)) {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(new Error('Erro ao parsear metadados do arquivo'));
            }
          } else {
            reject(new Error(`Erro ao obter metadados do arquivo: ${res.statusCode}`));
          }
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  function extractFileId(uploadUrl) {
    const match = uploadUrl.match(/\/files\/([a-zA-Z0-9_-]+)\?/);
    return match ? match[1] : null;
  }

  let uploadUrl = await getUploadUrl();

  const CHUNK = 256 * 1024 * 1024;
  const size = fs.statSync(filePath).size;
  const fd = fs.openSync(filePath, 'r');

  let offset = 0;

  while (offset < size) {
    const chunkSize = Math.min(CHUNK, size - offset);
    const buffer = Buffer.alloc(chunkSize);
    fs.readSync(fd, buffer, 0, chunkSize, offset);

    let attempt = 0;
    while (attempt < 3) {
      try {
        await new Promise((resolve, reject) => {
          const req = https.request(uploadUrl, {
            method: 'PUT',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Length': chunkSize,
              'Content-Range': `bytes ${offset}-${offset + chunkSize - 1}/${size}`
            }
          }, res => {
            if ([200, 201, 308].includes(res.statusCode)) {
              resolve();
            } else if (res.statusCode === 403) {
              reject(new Error('403'));
            } else {
              reject(new Error(`Erro ao enviar chunk: ${res.statusCode}`));
            }
          });
          req.on('error', reject);
          req.write(buffer);
          req.end();
        });
        break;
      } catch (err) {
        if (err.message === '403') {
          console.warn('⚠️ Token expirado ou inválido. Renovando token e URL de upload...');
          token = await generateGoogleDriveToken(chave);
          uploadUrl = await getUploadUrl();
          attempt++;
        } else {
          throw err;
        }
      }
    }
    if (attempt === 3) {
      throw new Error('❌ Falha após 3 tentativas de envio do chunk.');
    }
    offset += chunkSize;
  }
  fs.closeSync(fd);

  const fileId = extractFileId(uploadUrl);
  if (fileId) {
    console.log('🔍 Obtendo metadados do arquivo enviado...');
    try {
      const metadata = await getFileMetadata(fileId);
      console.log('✅ Arquivo enviado com sucesso. Metadados:');
      console.log(JSON.stringify(metadata, null, 2));
    } catch (err) {
      console.warn('⚠️ Falha ao obter metadados:', err.message);
    }
  } else {
    console.warn('⚠️ Não foi possível extrair fileId da URL de upload para obter metadados.');
  }
}

(async () => {
  try {
    if (!VIDEO_URL_RAW) throw new Error('Informe o link do vídeo.');

    const { chave, pastaDriveId } = await getGoogleDriveCredentials();

    const VIDEO_URL = normalizeUrl(VIDEO_URL_RAW);

    const original = path.join(__dirname, 'original.mp4');
    const final = path.join(__dirname, 'final.mp4');

    if (isYtOrFb(VIDEO_URL)) {
      downloadFromYtOrFb(VIDEO_URL, original);
    } else {
      const videoUrl = await getVideoUrlFromFilemoon(VIDEO_URL);
      spawnSync('ffmpeg', ['-i', videoUrl, '-c', 'copy', '-y', original], { stdio: 'inherit' });
    }

    if (!fs.existsSync(original)) throw new Error('Erro ao baixar vídeo.');

    reencode(original, final);

    if (DESTINO === 'drive') {
      await uploadToDrive(final, `video_240p_${Date.now()}.mp4`, chave, pastaDriveId);
      console.log('✅ Enviado ao Google Drive com sucesso!');
    } else {
      console.log('📁 Vídeo processado salvo localmente como final.mp4');
    }

    fs.unlinkSync(original);
    fs.unlinkSync(final);
  } catch (e) {
    console.error('❌ Erro:', e.message || e);
  }
})();
