# LLM Application Chatbot

A local web-based chatbot application built with Flask and JavaScript, integrated with Ollama for running LLM inference on your machine.

## Tools and Technologies Used

### Backend

- Python 3.10+
- Flask
- Flask-CORS
- Requests
- Ollama (local LLM runtime)
- Llama 3.2 model (`llama3.2:latest`)

### Frontend

- HTML5
- CSS3
- JavaScript (ES6+)

### DevOps and Environment

- Docker (optional containerized setup)
- Git and GitHub
- VS Code

## Key Features

- Browser-based chatbot interface
- Flask backend with REST endpoint for chat requests
- Integration with local Ollama model inference
- Conversation context support with short-term history
- Error handling for Ollama connection and runtime failures
- CORS enabled for frontend/backend communication

## Prerequisites

Install the following before running the project:

- Git
- Python 3.10+
- pip
- Ollama

Optional:

- Docker Desktop

Verify versions:

```bash
git --version
python --version
pip --version
ollama --version
docker --version
```

## Step-by-Step Setup and Usage

### 1. Clone the Repository

```bash
git clone <your-repository-url>
cd LLM_application_chatbot
```

### 2. Create and Activate a Virtual Environment

Windows PowerShell:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
```

macOS/Linux:

```bash
python -m venv .venv
source .venv/bin/activate
```

### 3. Install Python Dependencies

```bash
pip install -r requirements.txt
```

### 4. Start Ollama Service

In a separate terminal, run:

```bash
ollama serve
```

### 5. Pull the Required LLM Model

If the model is not already available:

```bash
ollama pull llama3.2:latest
```

### 6. Run the Flask Application

```bash
python app.py
```

The app runs at:

- `http://127.0.0.1:5000`

### 7. Use the Chatbot

- Open the app URL in your browser
- Type a message in the input box
- Submit and wait for the model response

## Optional Docker Setup

### 1. Build Docker Image

```bash
docker build -t llm-application-chatbot .
```

### 2. Run Docker Container

```bash
docker run -p 5000:5000 llm-application-chatbot
```

Note: The containerized app still needs access to a running Ollama service. Ensure Ollama is available from the container network.

## API Endpoint

- `POST /chatbot`
	- Request body:

```json
{
	"prompt": "Your message here"
}
```

	- Response body:

```json
{
	"response": "Model output text"
}
```

## Troubleshooting

- Error: Cannot connect to Ollama
	- Confirm `ollama serve` is running.
	- Confirm Ollama is listening on `http://localhost:11434`.
- Model not found
	- Run `ollama pull llama3.2:latest`.
- Flask server does not start
	- Ensure virtual environment is activated.
	- Reinstall dependencies with `pip install -r requirements.txt`.
- Port already in use
	- Stop the conflicting process or run on another port.

## Project Structure

```text
LLM_application_chatbot/
	app.py
	requirements.txt
	Dockerfile
	static/
		script.js
		css/
			style.css
	templates/
		index.html
```

## Summary

Built a local Flask-based chatbot application with a web UI that communicates with an Ollama-hosted LLM model. The project uses Python for backend APIs, JavaScript for client-side interaction, and supports both local virtual environment setup and optional Docker-based execution.
