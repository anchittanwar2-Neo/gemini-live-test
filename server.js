const WebSocket = require('ws');

const API_KEY = process.env.GEMINI_API_KEY || 'AIzaSyDdw2z1NqNknuNuZrc4lKlHvxA_O8s03ok';
const PORT = process.env.PORT || 8080;
const MODEL = 'gemini-3.1-flash-live-preview';
const GEMINI_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${API_KEY}`;

const wss = new WebSocket.Server({ port: PORT });
console.log(`Backend running on port ${PORT}`);

wss.on('connection', (browserWs) => {
  console.log('Browser connected');

  let geminiWs = null;
  let ready = false;

  geminiWs = new WebSocket(GEMINI_WS_URL);

  geminiWs.on('open', () => {
    console.log('Gemini WebSocket open — sending setup');

    const setup = {
      setup: {
        model: `models/${MODEL}`,
        generation_config: {
          response_modalities: ['AUDIO']
        },
        system_instruction: {
          parts: [{ text: 'You are a friendly fitness coach. Keep responses concise and practical. Help with workout advice, nutrition, and motivation.' }]
        }
      }
    };

    geminiWs.send(JSON.stringify(setup));
  });

  geminiWs.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.setupComplete !== undefined) {
        console.log('Gemini setup complete — ready');
        ready = true;
        browserWs.send(JSON.stringify({ type: 'status', message: 'Gemini connected' }));
        return;
      }

      if (msg.serverContent) {
        const parts = msg.serverContent?.modelTurn?.parts || [];
        for (const part of parts) {
          if (part.inlineData?.mimeType?.startsWith('audio')) {
            browserWs.send(JSON.stringify({ type: 'audio', data: part.inlineData.data }));
          }
        }
        if (msg.serverContent.turnComplete) {
          console.log('Gemini turn complete');
          browserWs.send(JSON.stringify({ type: 'turnComplete' }));
        }
      }

    } catch (e) {
      console.error('Error parsing Gemini message:', e.message);
    }
  });

  geminiWs.on('error', (e) => {
    console.error('Gemini WS error:', e.message);
    browserWs.send(JSON.stringify({ type: 'error', message: 'Gemini error: ' + e.message }));
  });

  geminiWs.on('close', (code, reason) => {
    console.log('Gemini WS closed:', code, reason.toString());
    ready = false;
  });

  browserWs.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'audio' && geminiWs && geminiWs.readyState === WebSocket.OPEN && ready) {
        const realtimeInput = {
          realtimeInput: {
            mediaChunks: [{
              mimeType: 'audio/pcm;rate=16000',
              data: msg.data
            }]
          }
        };
        geminiWs.send(JSON.stringify(realtimeInput));
      }
    } catch (e) {
      console.error('Error forwarding audio:', e.message);
    }
  });

  browserWs.on('close', () => {
    console.log('Browser disconnected');
    if (geminiWs) geminiWs.close();
  });

  browserWs.on('error', (e) => {
    console.error('Browser WS error:', e.message);
  });
});
