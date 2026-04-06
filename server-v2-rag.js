const WebSocket = require('ws');
const https = require('https');

const API_KEY = process.env.GEMINI_API_KEY || 'PASTE_YOUR_KEY_HERE';
const PORT = process.env.PORT || 8080;
const MODEL = 'gemini-3.1-flash-live-preview';
const FILE_STORE_ID = 'fileSearchStores/fitness-coach-knowledge-bas-domdkpckvkx8';
const GEMINI_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${API_KEY}`;

const wss = new WebSocket.Server({ port: PORT });
console.log(`Backend running on port ${PORT} (v3 clean)`);

function searchKnowledgeBase(query) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      contents: [{ parts: [{ text: query }] }],
      tools: [{ fileSearch: { fileSearchStoreNames: [FILE_STORE_ID] } }]
    });

    const options = {
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/gemini-2.5-flash:generateContent?key=${API_KEY}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            console.error('RAG API error:', JSON.stringify(parsed.error));
            resolve('No specific info found. Answer from general knowledge.');
            return;
          }
          const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) {
            console.log('RAG result (200 chars):', text.slice(0, 200));
            resolve(text);
          } else {
            console.log('RAG empty response:', JSON.stringify(parsed).slice(0, 300));
            resolve('No specific info found in knowledge base.');
          }
        } catch (e) {
          console.error('RAG parse error:', e.message);
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

wss.on('connection', (browserWs) => {
  console.log('Browser connected');
  let geminiWs = null;
  let ready = false;

  geminiWs = new WebSocket(GEMINI_WS_URL);

  geminiWs.on('open', () => {
    console.log('Gemini WS open — sending setup');
    geminiWs.send(JSON.stringify({
      setup: {
        model: `models/${MODEL}`,
        generation_config: { response_modalities: ['AUDIO'] },
        system_instruction: {
          parts: [{ text: `You are a fitness coach on a voice call. You have a knowledge base tool.
Use search_knowledge_base for ANY specific question about training protocols, rehab, supplements, nutrition plans, or course materials.
For simple conversational questions, answer directly.
Keep all spoken responses under 60 words. Be warm and practical.` }]
        },
        tools: [{
          function_declarations: [{
            name: 'search_knowledge_base',
            description: 'Search the fitness knowledge base for specific protocols, programmes, rehab, supplements, or course material questions.',
            parameters: {
              type: 'object',
              properties: { query: { type: 'string', description: 'The fitness topic to search for' } },
              required: ['query']
            }
          }]
        }]
      }
    }));
  });

  geminiWs.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.setupComplete !== undefined) {
        console.log('Gemini ready');
        ready = true;
        browserWs.send(JSON.stringify({ type: 'status', message: 'Gemini connected' }));
        return;
      }

      if (msg.toolCall) {
        const calls = msg.toolCall.functionCalls || [];
        const responses = [];
        for (const call of calls) {
          if (call.name === 'search_knowledge_base') {
            const query = call.args?.query || '';
            console.log('RAG triggered:', query);
            browserWs.send(JSON.stringify({ type: 'status', message: 'Searching knowledge base...' }));
            try {
              const result = await searchKnowledgeBase(query);
              responses.push({ id: call.id, name: call.name, response: { result } });
            } catch (e) {
              responses.push({ id: call.id, name: call.name, response: { result: 'Search failed. Use general knowledge.' } });
            }
          }
        }
        if (responses.length > 0) {
          geminiWs.send(JSON.stringify({ toolResponse: { functionResponses: responses } }));
        }
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
          console.log('Turn complete');
          browserWs.send(JSON.stringify({ type: 'turnComplete' }));
        }
      }

    } catch (e) {
      console.error('Gemini msg error:', e.message);
    }
  });

  geminiWs.on('error', (e) => {
    console.error('Gemini error:', e.message);
    browserWs.send(JSON.stringify({ type: 'error', message: e.message }));
  });

  geminiWs.on('close', (code, reason) => {
    console.log('Gemini closed:', code, reason.toString());
    ready = false;
  });

  browserWs.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'audio' && geminiWs?.readyState === WebSocket.OPEN && ready) {
        geminiWs.send(JSON.stringify({
          realtimeInput: { audio: { data: msg.data, mimeType: 'audio/pcm;rate=16000' } }
        }));
      }
    } catch (e) {
      console.error('Browser msg error:', e.message);
    }
  });

  browserWs.on('close', () => { console.log('Browser disconnected'); geminiWs?.close(); });
  browserWs.on('error', (e) => console.error('Browser error:', e.message));
});
