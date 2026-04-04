const WebSocket = require('ws');
const https = require('https');

const API_KEY = process.env.GEMINI_API_KEY || 'PASTE_YOUR_KEY_HERE';
const PORT = process.env.PORT || 8080;
const MODEL = 'gemini-3.1-flash-live-preview';
const FILE_STORE_ID = 'fileSearchStores/fitness-coach-knowledge-bas-domdkpckvkx8';
const GEMINI_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${API_KEY}`;

const wss = new WebSocket.Server({ port: PORT });
console.log(`Backend running on port ${PORT} (v2 with RAG)`);

// Search the fitness knowledge base via File Store REST API
function searchKnowledgeBase(query) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      tools: [{
        file_search: {
          file_search_store_names: [FILE_STORE_ID]
        }
      }],
      contents: [{
        parts: [{ text: query }]
      }]
    });

    const options = {
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/gemini-2.0-flash:generateContent?key=${API_KEY}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text || 'No relevant information found.';
          console.log('RAG result for query:', query, '| Answer length:', text.length);
          resolve(text);
        } catch (e) {
          reject(new Error('Failed to parse RAG response: ' + e.message));
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
    console.log('Gemini WebSocket open — sending setup');

    const setup = {
      setup: {
        model: `models/${MODEL}`,
        generation_config: {
          response_modalities: ['AUDIO']
        },
        system_instruction: {
          parts: [{ text: `You are a fitness coach on a voice call. You have access to a knowledge base tool with proprietary fitness course materials.

Follow this process:
- For simple general questions (protein per kg, sleep, hydration), answer directly.
- For specific protocols, injury rehab, periodisation, supplement stacking, or programme design — use the search_knowledge_base tool to look it up first.
- Keep all responses concise and under 60 words when spoken.
- Be warm, direct, and practical.
- Never ask more than one question at a time.` }]
        },
        tools: [{
          function_declarations: [{
            name: 'search_knowledge_base',
            description: 'Search the fitness coaching knowledge base for specific protocols, programmes, rehab methods, or detailed methodology from course materials. Use for specific questions that require proprietary information.',
            parameters: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description: 'The specific fitness question or topic to search for'
                }
              },
              required: ['query']
            }
          }]
        }]
      }
    };

    geminiWs.send(JSON.stringify(setup));
  });

  geminiWs.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());

      // Setup complete
      if (msg.setupComplete !== undefined) {
        console.log('Gemini setup complete — ready');
        ready = true;
        browserWs.send(JSON.stringify({ type: 'status', message: 'Gemini connected' }));
        return;
      }

      // Handle function/tool calls from Gemini
      if (msg.toolCall) {
        const functionCalls = msg.toolCall.functionCalls || [];
        const responses = [];

        for (const call of functionCalls) {
          if (call.name === 'search_knowledge_base') {
            const query = call.args?.query || '';
            console.log('RAG search triggered:', query);
            browserWs.send(JSON.stringify({ type: 'status', message: 'Searching knowledge base...' }));

            try {
              const result = await searchKnowledgeBase(query);
              responses.push({
                id: call.id,
                name: call.name,
                response: { result }
              });
            } catch (e) {
              console.error('RAG search failed:', e.message);
              responses.push({
                id: call.id,
                name: call.name,
                response: { result: 'Knowledge base search failed. Please answer from general knowledge.' }
              });
            }
          }
        }

        // Send all function responses back to Gemini
        if (responses.length > 0) {
          geminiWs.send(JSON.stringify({
            toolResponse: {
              functionResponses: responses
            }
          }));
        }
        return;
      }

      // Audio response from Gemini
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
            audio: {
              data: msg.data,
              mimeType: 'audio/pcm;rate=16000'
            }
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
