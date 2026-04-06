const WebSocket = require('ws');
const https = require('https');

const API_KEY = process.env.GEMINI_API_KEY || 'PASTE_YOUR_KEY_HERE';
const PORT = process.env.PORT || 8080;
const MODEL = 'gemini-3.1-flash-live-preview';
const FILE_STORE_ID = 'fileSearchStores/fitness-coach-knowledge-bas-domdkpckvkx8';
const GEMINI_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${API_KEY}`;

const wss = new WebSocket.Server({ port: PORT });
console.log(`Backend running on port ${PORT} (v2 RAG - fixed)`);

function searchKnowledgeBase(query) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      contents: [{
        parts: [{ text: query }]
      }],
      tools: [{
        fileSearch: {
          fileSearchStoreNames: [FILE_STORE_ID]
        }
      }]
    });

    const options = {
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/gemini-2.5-flash:generateContent?key=${API_KEY}`,
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
          console.log('RAG HTTP status:', res.statusCode);

          // Log error if any
          if (parsed.error) {
            console.error('RAG API error:', JSON.stringify(parsed.error));
            resolve('Knowledge base search returned an error. Please answer from general knowledge.');
            return;
          }

          const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) {
            console.log('RAG result (first 200 chars):', text.slice(0, 200));
            resolve(text);
          } else {
            console.log('RAG full response:', JSON.stringify(parsed).slice(0, 500));
            resolve('No specific information found in the knowledge base for this query.');
          }
        } catch (e) {
          console.error('RAG parse error:', e.message);
          reject(e);
        }
      });
    });

    req.on('error', (e) => {
      console.error('RAG request error:', e.message);
      reject(e);
    });
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
          parts: [{ text: `You are a fitness coach on a voice call with access to a fitness knowledge base.

IMPORTANT: You MUST use the search_knowledge_base tool for ANY question about:
- Specific training protocols or programmes
- Injury rehabilitation
- Supplement protocols
- Nutrition plans or methodologies
- Anything from course materials or books

Do NOT answer these from memory. Always search first, then answer based on the results.
For truly simple questions (e.g. "how are you"), answer directly without searching.
Keep spoken responses under 60 words. Be warm and direct.` }]
        },
        tools: [{
          function_declarations: [{
            name: 'search_knowledge_base',
            description: 'Search the fitness coaching knowledge base. MUST be used for any specific fitness protocol, programme, rehab, supplement, or nutrition question.',
            parameters: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description: 'The fitness question or topic to search for'
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
      const keys = Object.keys(msg);

      // Only log non-session-resumption messages
      if (!msg.sessionResumptionUpdate) {
        console.log('Gemini msg keys:', keys.join(', '));
      }

      if (msg.setupComplete !== undefined) {
        console.log('Gemini setup complete — ready');
        ready = true;
        browserWs.send(JSON.stringify({ type: 'status', message: 'Gemini connected' }));
        return;
      }

      if (msg.toolCall) {
        console.log('TOOL CALL:', JSON.stringify(msg.toolCall).slice(0, 300));
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
              console.error('RAG failed:', e.message);
              responses.push({
                id: call.id,
                name: call.name,
                response: { result: 'Search failed. Please answer from general knowledge.' }
              });
            }
          }
        }

        if (responses.length > 0) {
          geminiWs.send(JSON.stringify({
            toolResponse: {
              functionResponses: responses
            }
          }));
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

      if (msg.type === 'endTurn' && geminiWs && geminiWs.readyState === WebSocket.OPEN && ready) {
        console.log('End of turn signal — triggering Gemini response');
        geminiWs.send(JSON.stringify({
          clientContent: {
            turns: [],
            turnComplete: true
          }
        }));
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
