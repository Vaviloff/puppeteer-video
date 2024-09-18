const puppeteer = require('puppeteer');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

async function startBrowserAndStream() {
  const browser = await puppeteer.launch({
    headless: false,
    args: ['--use-fake-ui-for-media-stream']
  });

  const page = await browser.newPage();

  // Navigate to the page you want to capture
  await page.goto('https://example.com');

  // Inject the MediaRecorder script
  await page.evaluate(() => {
    window.videoStream = null;
    window.mediaRecorder = null;

    async function startCapture() {
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: { mediaSource: "screen" }
        });
        window.videoStream = stream;
        
        const mimeType = 'video/webm;codecs=vp9';
        window.mediaRecorder = new MediaRecorder(stream, { mimeType });

        mediaRecorder.ondataavailable = (event) => {
          if (event.data.size > 0) {
            window.postMessage({
              type: 'videoChunk',
              chunk: event.data
            }, '*');
          }
        };

        mediaRecorder.start(1000); // Capture in 1-second chunks
      } catch (err) {
        console.error("Error: " + err);
      }
    }

    startCapture();
  });

  // Set up a WebSocket server for streaming video chunks
  const wss = new WebSocket.Server({ port: 8080 });

  wss.on('connection', (ws) => {
    console.log('Client connected');

    page.on('console', msg => console.log('PAGE LOG:', msg.text()));

    page.exposeFunction('sendVideoChunk', (chunk) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(chunk);
      }
    });

    page.evaluate(() => {
      window.addEventListener('message', async (event) => {
        if (event.data.type === 'videoChunk') {
          const arrayBuffer = await event.data.chunk.arrayBuffer();
          const uint8Array = new Uint8Array(arrayBuffer);
          await window.sendVideoChunk(Array.from(uint8Array));
        }
      });
    });
  });

  // Create a simple HTML page for viewing the stream
  const viewerHTML = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Video Stream Viewer</title>
    </head>
    <body>
      <video id="videoElement" autoplay controls></video>
      <script>
        const video = document.getElementById('videoElement');
        const mediaSource = new MediaSource();
        video.src = URL.createObjectURL(mediaSource);

        mediaSource.addEventListener('sourceopen', () => {
          const sourceBuffer = mediaSource.addSourceBuffer('video/webm;codecs=vp9');
          const ws = new WebSocket('ws://localhost:8080');

          ws.onmessage = (event) => {
            const data = new Uint8Array(event.data);
            sourceBuffer.appendBuffer(data);
          };
        });
      </script>
    </body>
    </html>
  `;

  // Serve the viewer HTML
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(viewerHTML);
  });

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
