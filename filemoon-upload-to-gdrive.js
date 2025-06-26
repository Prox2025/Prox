const puppeteer = require('puppeteer');
const fs = require('fs');
const https = require('https');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const FILEMOON_URL = process.argv[2];
const TASK_ID = process.argv[3]; // ID único vindo do HTML
const STATUS_SERVER = 'https://livestream.ct.ws/M/status.php';
const CRED_SERVER = 'https://livestream.ct.ws/M/upload.php';
const delay = ms => new Promise(r => setTimeout(r, ms));

// Atualizar status via Puppeteer
async function updateStatusPuppeteer(dados) {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox','--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  const query = new URLSearchParams({ id: TASK_ID, ...dados });
  await page.goto(`${STATUS_SERVER}?${query.toString()}`, { waitUntil: 'networkidle2', timeout: 60000 });
  await delay(1000);
  await browser.close();
}

// Obter credenciais Google Drive
async function getGoogleDriveCredentials() {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox','--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.goto(CRED_SERVER, { waitUntil: 'networkidle2', timeout: 60000 });
  await delay(5000);
  const json = await page.evaluate(() => {
    try { return JSON.parse(document.body.innerText); } catch { return null; }
  });
  await browser.close();
  if (!json || !json.chave || !json.pastaDriveId) throw new Error('Credenciais inválidas.');
  return json;
}

// Gerar token JWT
async function generateGoogleDriveToken(chave) {
  const now = Math.floor(Date.now()/1000);
  const header = Buffer.from(JSON.stringify({alg:'RS256',typ:'JWT'})).toString('base64url');
  const claim = Buffer.from(JSON.stringify({
    iss: chave.client_email,
    scope: 'https://www.googleapis.com/auth/drive.file',
    aud: chave.token_uri,
    exp: now+3600,
    iat: now
  })).toString('base64url');
  const toSign = `${header}.${claim}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(toSign);
  const signature = signer.sign(chave.private_key, 'base64url');
  const jwt = `${toSign}.${signature}`;

  return new Promise((resolve, reject) => {
    const postData = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    }).toString();

    const req = https.request(chave.token_uri, {
      method:'POST',
      headers:{
        'Content-Type':'application/x-www-form-urlencoded',
        'Content-Length': postData.length
      }
    }, res => {
      let data = '';
      res.on('data', chunk => data+=chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if(json.access_token) resolve(json.access_token);
          else reject(new Error('Token não recebido: ' + data));
        } catch(e) {
          reject(new Error('Erro no JSON: ' + data));
        }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// Upload resumido (com progresso real)
async function uploadResumable(filePath, nome, token, pastaDriveId) {
  const metadata = { name: nome, parents: [pastaDriveId] };
  const url = new URL('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable');
  const postData = JSON.stringify(metadata);

  const resumableUrl = await new Promise((resolve,reject) => {
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, res => {
      const location = res.headers['location'];
      if (!location) return reject(new Error('URL de upload não encontrada.'));
      resolve(location);
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const CHUNK_SIZE = 256 * 1024 * 1024;
  const fd = fs.openSync(filePath, 'r');
  let offset = 0;

  while (offset < fileSize) {
    const chunkSize = Math.min(CHUNK_SIZE, fileSize - offset);
    const buffer = Buffer.alloc(chunkSize);
    fs.readSync(fd, buffer, 0, chunkSize, offset);

    const progresso = Math.floor((offset + chunkSize) / fileSize * 100);
    await updateStatusPuppeteer({ status: 'upload', progresso, mensagem: `Enviando para Google Drive: ${progresso}%` });

    await new Promise((resolve, reject) => {
      const req = https.request(resumableUrl, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Length': chunkSize,
          'Content-Range': `bytes ${offset}-${offset+chunkSize -1}/${fileSize}`
        }
      }, res => {
        if ([200, 201, 308].includes(res.statusCode)) resolve();
        else reject(new Error('Erro no envio do chunk'));
      });
      req.on('error', reject);
      req.write(buffer);
      req.end();
    });

    offset += chunkSize;
  }

  fs.closeSync(fd);
  await updateStatusPuppeteer({ status: 'concluido', progresso: 100, mensagem: '✅ Vídeo enviado ao Google Drive!' });
}

// Extrair resoluções do Filemoon
async function getVideoResolutions(url) {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox','--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.goto(url, {waitUntil: 'networkidle2', timeout: 60000});
  await delay(8000);

  const iframeUrl = await page.evaluate(() => {
    const iframe = document.querySelector('iframe');
    return iframe ? iframe.src : null;
  });

  const iframePage = await browser.newPage();
  await iframePage.goto(iframeUrl, {waitUntil: 'networkidle2', timeout: 60000});
  await delay(8000);

  const resultado = await iframePage.evaluate(() => {
    return new Promise(resolve => {
      const formatos = ['.mp4', '.m3u8'];
      const resolucoes = [];

      window.jwplayer = function () {
        return {
          setup: function (config) {
            if (Array.isArray(config.sources)) {
              config.sources.forEach(src => {
                if (src.file && formatos.some(f => src.file.includes(f))) {
                  resolucoes.push({ resolucao: src.label || 'Desconhecido', url: src.file });
                }
              });
            }
            resolve(resolucoes);
          }
        }
      };

      document.querySelectorAll('script').forEach(s => {
        if (s.textContent.includes('jwplayer')) {
          try { eval(s.textContent); } catch {}
        }
      });

      setTimeout(() => resolve(resolucoes), 5000);
    });
  });

  await browser.close();
  return resultado;
}

async function aguardarResolucaoEscolhida() {
  let resolucao = null;
  while (!resolucao) {
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox','--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.goto(`${STATUS_SERVER}?id=${TASK_ID}`, { waitUntil: 'networkidle2', timeout: 60000 });
    const json = await page.evaluate(() => {
      try { return JSON.parse(document.body.innerText); } catch { return {}; }
    });
    await browser.close();
    if (json.resolucao_escolhida) resolucao = json.resolucao_escolhida;
    await delay(3000);
  }
  return resolucao;
}

async function baixarVideoComProgresso(url) {
  return new Promise((resolve, reject) => {
    const output = path.join(__dirname, 'video.mp4');
    const ffmpeg = spawn('ffmpeg', ['-i', url, '-c', 'copy', '-y', output]);

    ffmpeg.stderr.on('data', async data => {
      const match = data.toString().match(/time=(\d+):(\d+):(\d+\.\d+)/);
      if (match) {
        const segundos = (+match[1]) * 3600 + (+match[2]) * 60 + parseFloat(match[3]);
        const progresso = Math.min(100, Math.floor((segundos / 600) * 100));
        await updateStatusPuppeteer({ status: 'baixando', progresso, mensagem: `Baixando... ${progresso}%` });
      }
    });

    ffmpeg.on('exit', async code => {
      if (code === 0) {
        await updateStatusPuppeteer({ status: 'baixado', progresso: 100, mensagem: 'Download concluído!' });
        resolve(output);
      } else {
        reject(new Error('Erro no ffmpeg'));
      }
    });
  });
}

// 👇 EXECUÇÃO
(async () => {
  try {
    if (!FILEMOON_URL || !TASK_ID) throw new Error('Parâmetros ausentes');
    await updateStatusPuppeteer({ status: 'iniciando', mensagem: 'Iniciando extração do vídeo...' });

    const resolucoes = await getVideoResolutions(FILEMOON_URL);
    await updateStatusPuppeteer({ status: 'resolucoes', opcoes: JSON.stringify(resolucoes), mensagem: 'Escolha a resolução' });

    const escolhida = await aguardarResolucaoEscolhida();
    const video = resolucoes.find(v => v.resolucao === escolhida);
    if (!video) throw new Error('Resolução inválida');

    await updateStatusPuppeteer({ status: 'download', mensagem: `Baixando ${escolhida}...` });
    const videoPath = await baixarVideoComProgresso(video.url);

    const { chave, pastaDriveId } = await getGoogleDriveCredentials();
    const token = await generateGoogleDriveToken(chave);

    await uploadResumable(videoPath, `video_${Date.now()}.mp4`, token, pastaDriveId);
    fs.unlinkSync(videoPath);
  } catch (e) {
    await updateStatusPuppeteer({ status: 'erro', mensagem: e.message || 'Erro desconhecido' });
    console.error(e);
  }
})();
