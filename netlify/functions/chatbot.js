// This file runs on Netlify's servers, not in the user's browser
// When the user sends a message, script.js calls this file behind the scenes
// This file's job: receive the message, contact the Groq AI, and send the reply back
//

// Main handler — this runs every time a user sends a chat message
exports.handler = async (event) => {

  // Handle browser "preflight" check — browsers send this before the real request
  // to make sure the server allows the connection (a standard security handshake)
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',        // Allow requests from any website
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      },
      body: '',
    };
  }

  // Only accept POST requests — reject anything else (e.g. someone visiting the URL directly)
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    // Unpack the incoming message from script.js
    const data = JSON.parse(event.body || '{}');
    const userMessage = data.prompt || '';           // The message the user typed
    const history = Array.isArray(data.history) ? data.history : []; // Previous messages for context

    // If no message was actually sent, return early with an error
    if (!userMessage) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response: 'No prompt provided.' }),
      };
    }
    //

    // Load the secret API key stored safely on Netlify's servers
    // This key is never visible to users — it only exists here on the server
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response: 'Server configuration error: API key missing.' }),
      };
    }
    //

    // Build the full conversation to send to the AI
    // This includes a starting instruction ("be a helpful assistant"),
    // all previous messages so the AI remembers context, and the new user message
    const messages = [
      { role: 'system', content: 'You are a helpful assistant.' }, // Background instruction for the AI
      ...history,       // Previous back-and-forth messages
      { role: 'user', content: userMessage }, // The new message from the user
    ];
    //

    // Send the conversation to Groq's AI and wait for a reply
    const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`, // Prove we are allowed to use this AI service
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile', // Which AI model to use (Llama 3.3, very capable)
        messages,
        max_tokens: 1024, // Limit how long the AI's reply can be
      }),
    });

    // If Groq returned an error, throw it so we can handle it below
    if (!groqResponse.ok) {
      const errText = await groqResponse.text();
      throw new Error(`Groq API error ${groqResponse.status}: ${errText}`);
    }
    //

    // Extract the AI's reply text and send it back to script.js
    const groqData = await groqResponse.json();
    const reply = groqData.choices[0].message.content; // The actual text the AI wrote

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*', // Allow script.js (in the browser) to read this response
      },
      body: JSON.stringify({ response: reply }),
    };
    //

  } catch (error) {
    // If anything went wrong, send a friendly error message back to the browser
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response: `Error: ${error.message}` }),
    };
  }
};
