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

async function getCredentials() {
  console.log('🌐 Acessando servidor para obter credenciais...');
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.goto(SERVER_URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await delay(3000);
  const json = await page.evaluate(() => {
    try { return JSON.parse(document.body.innerText); } catch { return null; }
  });
  await browser.close();
  if (!json || !json.rclone || !json.rclone.access_token) throw new Error('Credenciais inválidas');
  return json.rclone;
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

async function refreshAccessToken(rclone) {
  console.log('🔄 Renovando access_token...');
  const data = new URLSearchParams({
    client_id: rclone.client_id,
    client_secret: rclone.client_secret,
    refresh_token: rclone.refresh_token,
    grant_type: 'refresh_token'
  }).toString();

  return new Promise((resolve, reject) => {
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
          else reject(new Error('Falha ao renovar token: ' + body));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function uploadToDrive(filePath, fileName, rclone, folderId) {
  let accessToken = rclone.access_token;

  // Verifica se token é válido, senão renova (pode implementar lógica mais robusta aqui)
  // Aqui vamos tentar usar e renovar só em erro, para simplificar.

  const metadata = JSON.stringify({ name: fileName, parents: [folderId] });
  const fileData = fs.readFileSync(filePath);
  const boundary = '-------314159265358979323846';
  const delimiter = `\r\n--${boundary}\r\n`;
  const closeDelimiter = `\r\n--${boundary}--`;

  const contentType = 'video/mp4';

  const body =
    delimiter +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    metadata +
    delimiter +
    `Content-Type: ${contentType}\r\n\r\n` +
    fileData +
    closeDelimiter;

  async function sendRequest(token) {
    return new Promise((resolve, reject) => {
      const options = {
        method: 'POST',
        hostname: 'www.googleapis.com',
        path: '/upload/drive/v3/files?uploadType=multipart',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': `multipart/related; boundary=${boundary}`
        }
      };
      const req = https.request(options, res => {
        let resData = '';
        res.on('data', chunk => resData += chunk);
        res.on('end', () => {
          if (res.statusCode === 401) reject(new Error('Unauthorized'));
          else if (res.statusCode >= 200 && res.statusCode < 300) resolve(resData);
          else reject(new Error(`HTTP ${res.statusCode}: ${resData}`));
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  try {
    const res = await sendRequest(accessToken);
    return JSON.parse(res);
  } catch (err) {
    if (err.message === 'Unauthorized') {
      // Tentar renovar token
      accessToken = await refreshAccessToken(rclone);
      const res = await sendRequest(accessToken);
      return JSON.parse(res);
    }
    throw err;
  }
}

(async () => {
  try {
    if (!VIDEO_URL) throw new Error('Informe o link do vídeo.');

    const rclone = await getCredentials();
    const pastaDriveId = rclone.folderId || '1Fbvv0QvJSesaMcByxH3y8GaG_Jy-kBmC';

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
      const uploadRes = await uploadToDrive(final, nome, rclone, pastaDriveId);
      console.log('✅ Upload concluído:', uploadRes);
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
