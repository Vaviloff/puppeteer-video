const express = require('express');
const puppeteer = require('puppeteer');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const clients = new Set();
let initSegment = null;

async function startBrowserAndStream() {
  const browser = await puppeteer.launch({
    headless: false,
    args: [
      '--use-fake-ui-for-media-stream',
      '--allow-file-access-from-files', // Allows file access
      '--auto-select-desktop-capture-source=Entire screen', // Auto-select screen capture
      '--no-sandbox', // Disable sandbox, useful for some environments
      '--disable-dev-shm-usage', // Increase shared memory usage if needed
      '--auto-accept-this-tab-capture',
      '--disable-infobars',
      `--window-size=1920,1080`,
    ],
  });

  // Set up a WebSocket server for streaming video chunks
  const wss = new WebSocket.Server({ port: 8080 });
  wss.on('connection', (ws) => {
    console.log('Client connected');

    clients.add(ws);
    // if (initSegment) {
    //   console.log('Sending initialization segment to new client');
    //   ws.send(initSegment);
    // }
  });

  const page = await browser.newPage();
  page.setViewport({ width: 1920, height: 1080 });

  page.on('console', (msg) => console.log('PAGE LOG:', msg.text()));

  // Navigate to the page you want to capture
  await page.goto('https://vaviloff.ru/files/cat/');

  await page.exposeFunction('sendVideoChunk', (chunk) => {
    if (!initSegment) {
      console.log('Received and stored initialization segment');
      initSegment = chunk;
    }

    fs.writeFileSync(`video/${new Date().getTime()}.webm`, Buffer.from(chunk));

    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        console.log(`Sending chunk of size: ${chunk.length}`);
        client.send(Buffer.from(chunk));
      }
    }
  });

  console.log('Adding MediaStreamRecorder.js');
  await page.addScriptTag({ url: 'https://vaviloff.ru/files/cat/MediaStreamRecorder.js' });

  await page.evaluate(() => {
    console.log(`Adding event listener for video chunks`);
    window.addEventListener('message', async (event) => {
      console.log('Received message:', event.data);
      if (event.data.type === 'videoChunk') {
        const arrayBuffer = await event.data.chunk.arrayBuffer();
        const uint8Array = new Uint8Array(arrayBuffer);
        await window.sendVideoChunk(Array.from(uint8Array));
      }
    });
  });

  // Inject the MediaRecorder script
  await page.evaluate(() => {
    window.videoStream = null;
    window.mediaRecorder = null;

    const displayMediaOptions = {
      video: {
        displaySurface: 'browser',
      },
      // audio: {
      //   suppressLocalAudioPlayback: false,
      // },
      preferCurrentTab: false,
      selfBrowserSurface: 'exclude',
      systemAudio: 'exclude',
      surfaceSwitching: 'include',
      monitorTypeSurfaces: 'include',
    };

    async function startCapture() {
      try {
        const stream =
          await navigator.mediaDevices.getDisplayMedia(displayMediaOptions);
        window.videoStream = stream;

        // const mimeType = 'video/webm;codecs=vp8';
        // window.mediaRecorder = new MediaRecorder(stream, {
        //   mimeType,
        //   videoKeyFrameIntervalDuration: 15,
        // });

        window.mediaRecorder = new MediaStreamRecorder(stream);
        mediaRecorder.mimeType = 'video/webm';
        mediaRecorder.audioChannels = 1;
        mediaRecorder.start(8000);

        mediaRecorder.ondataavailable = (blob) => {          
          if (true) {
            console.log(
              `Captured chunk of size: ${blob.length}`,
            );

            const file = new File(
              [blob],
              'msr-' + new Date().toISOString().replace(/:|\./g, '-') + '.webm',
              {
                type: 'video/webm',
              },
            );

            window.postMessage(
              {
                type: 'videoChunk',
                chunk: file,
              },
              '*',
            );
          }
        };

        mediaRecorder.start(5000); // Capture in 1-second chunks
      } catch (err) {
        console.error('Error: ' + err);
      }
    }

    startCapture();
  });

  const app = express();
  const server = http.createServer(app);

  app.get('/', (req, res) => {
    res.send(fs.readFileSync('viewer.html', 'utf8'));
  });

  app.get('/scripts/MediaStreamRecorder.js', (req, res) => {
    console.log('Sending MediaStreamRecorder.js');
    res.send(fs.readFileSync('MediaStreamRecorder.js', 'utf8'));
  });

  // const server = http.createServer((req, res) => {
  //   res.writeHead(200, { 'Content-Type': 'text/html' });
  //   res.end(viewerHTML);
  // });

  server.listen(3000, () => {
    console.log('Viewer available at http://localhost:3000');
  });

  // Cleanup function
  async function cleanup() {
    await browser.close();
    server.close();
    wss.close();
    console.log('Cleanup completed');
  }

  // Handle script termination
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

startBrowserAndStream().catch(console.error);
