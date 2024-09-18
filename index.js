const puppeteer = require('puppeteer');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
async function startBrowserAndStream() {
  const browser = await puppeteer.launch({
    headless: false,
    args: [
      '--use-fake-ui-for-media-stream',
      '--allow-file-access-from-files',  // Allows file access
      '--auto-select-desktop-capture-source=Entire screen', // Auto-select screen capture
      '--no-sandbox', // Disable sandbox, useful for some environments
      '--disable-dev-shm-usage', // Increase shared memory usage if needed
      '--auto-accept-this-tab-capture',
    ]
  });

  const page = await browser.newPage();

  // Navigate to the page you want to capture
  await page.goto('https://example.com');

  // Inject the MediaRecorder script
  await page.evaluate(() => {
    window.videoStream = null;
    window.mediaRecorder = null;

    const displayMediaOptions = {
      video: {
        displaySurface: "browser",
      },
      // audio: {
      //   suppressLocalAudioPlayback: false,
      // },
      preferCurrentTab: false,
      selfBrowserSurface: "exclude",
      systemAudio: "exclude",
      surfaceSwitching: "include",
      monitorTypeSurfaces: "include",
    };

    async function startCapture() {
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia(displayMediaOptions);
        window.videoStream = stream;
        
        const mimeType = 'video/webm;codecs=vp8';
        window.mediaRecorder = new MediaRecorder(stream, { mimeType });

        mediaRecorder.ondataavailable = (event) => {
          if (event.data.size > 0) {
            console.log(`Captured chunk of size: ${event.data.size} and type ${event.data.type}`);
            window.postMessage({
              type: 'videoChunk',
              chunk: event.data
            }, '*');
          }
        };

        mediaRecorder.start(3000); // Capture in 1-second chunks
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
        console.log(`Sending chunk of size: ${chunk.length}`);
        ws.send(Buffer.from(chunk));
        require('fs').writeFileSync('chunk.webm', Buffer.from(chunk));
      }
    });

    page.evaluate(() => {
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
  });

  // Create a simple HTML page for viewing the stream
  const viewerHTML = fs.readFileSync('viewer.html', 'utf8');

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