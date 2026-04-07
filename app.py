# Import required libraries
from flask import Flask, request, render_template  # Flask for web server
from flask_cors import CORS  # Enable cross-origin requests
import json  # For handling JSON data
import requests  # For making API calls to Ollama

# Initialize Flask application
app = Flask(__name__)
CORS(app)  # Allow frontend to communicate with backend

# Ollama configuration
OLLAMA_API_URL = "http://localhost:11434/api/generate"  # Ollama API endpoint
MODEL_NAME = "llama3.2:latest"  # Llama3.2 model name in Ollama
conversation_history = []  # Store conversation for context

@app.route('/', methods=['GET'])
def home():
    """Serve the main chatbot web interface"""
    return render_template('index.html')


@app.route('/chatbot', methods=['POST'])
def handle_prompt():
    """Handle chat messages from the frontend and return AI responses via Ollama"""
    try:
        # Extract the user's message from the request
        data = request.get_data(as_text=True)
        data = json.loads(data)
        print(data)  # DEBUG: Log incoming messages
        input_text = data['prompt']
        
        # Build conversation context from previous messages
        history = "\n".join(conversation_history)
        
        # Combine history with new input for context-aware responses
        full_input = f"{history}\nUser: {input_text}" if history else f"User: {input_text}"
        
        # Prepare request payload for Ollama API
        payload = {
            "model": MODEL_NAME,
            "prompt": full_input,
            "stream": False  # Get complete response at once
        }
        
        # Call Ollama API to generate response
        print("Calling Ollama API...")
        ollama_response = requests.post(OLLAMA_API_URL, json=payload)
        
        if ollama_response.status_code == 200:
            # Extract the generated text from Ollama's response
            response = ollama_response.json()['response'].strip()
            
            # Save this interaction to conversation history for context
            conversation_history.append(f"User: {input_text}")
            conversation_history.append(f"Assistant: {response}")
            
            # Keep conversation history manageable (last 10 exchanges)
            if len(conversation_history) > 20:
                conversation_history.pop(0)
                conversation_history.pop(0)
            
            # Return response as JSON
            return json.dumps({"response": response})
        else:
            error_msg = "Error: Could not connect to Ollama. Make sure Ollama is running (ollama serve)."
            print(f"Ollama API error: {ollama_response.status_code}")
            return json.dumps({"response": error_msg})
            
    except requests.exceptions.ConnectionError:
        error_msg = "Error: Cannot connect to Ollama. Please start Ollama service (run 'ollama serve' in terminal)."
        print(error_msg)
        return json.dumps({"response": error_msg})
    except Exception as e:
        error_msg = f"Error: {str(e)}"
        print(error_msg)
        return json.dumps({"response": error_msg})

if __name__ == '__main__':
    print("Starting Flask server...")
    print("Server will be ready at http://127.0.0.1:5000")
    print("Make sure Ollama is running: 'ollama serve'")
    print(f"Using model: {MODEL_NAME}")
    app.run(debug=True)  # Start server with debug mode for helpful error messages

