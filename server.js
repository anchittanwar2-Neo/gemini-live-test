const WebSocket = require('ws');
const { GoogleGenAI } = require('@google/genai');

const API_KEY = process.env.GEMINI_API_KEY || 'AIzaSyDdw2z1NqNknuNuZrc4lKlHvxA_O8s03ok';
const PORT = process.env.PORT || 8080;

const ai = new GoogleGenAI({ apiKey: API_KEY });

const wss = new WebSocket.Server({ port: PORT });
console.log(`Backend running on port ${PORT}`);

wss.on('connection', async (browserWs) => {
  console.log('Browser connected');

  let geminiSession;

  try {
    geminiSession = await ai.live.connect({
      model: 'gemini-3.1-flash-live-preview',
      config: {
        responseModalities: ['AUDIO'],
        systemInstruction: {
          parts: [{ text: 'You are a friendly fitness coach. Keep responses concise and practical. Help with workout advice, nutrition, and motivation.' }]
        }
      },
      callbacks: {
        onopen: () => {
          console.log('Gemini session open');
          browserWs.send(JSON.stringify({ type: 'status', message: 'Gemini connected' }));
        },
        onmessage: (response) => {
          // Forward Gemini audio back to browser
          if (response.data) {
            browserWs.send(JSON.stringify({ type: 'audio', data: response.data }));
          }
          if (response.serverContent?.turnComplete) {
            browserWs.send(JSON.stringify({ type: 'turnComplete' }));
          }
        },
        onerror: (e) => {
          console.error('Gemini error:', e);
          browserWs.send(JSON.stringify({ type: 'error', message: e.message }));
        },
        onclose: () => console.log('Gemini session closed')
      }
    });
  } catch (e) {
    console.error('Failed to connect to Gemini:', e);
    browserWs.send(JSON.stringify({ type: 'error', message: 'Failed to connect to Gemini: ' + e.message }));
    browserWs.close();
    return;
  }

  // Receive audio from browser, forward to Gemini
  browserWs.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'audio' && geminiSession) {
        await geminiSession.sendRealtimeInput({
          audio: { data: msg.data, mimeType: 'audio/pcm;rate=16000' }
        });
      }
    } catch (e) {
      console.error('Error forwarding audio:', e);
    }
  });

  browserWs.on('close', () => {
    if (geminiSession) geminiSession.close();
    console.log('Browser disconnected');
  });
});
