# LLM Application Chatbot

A publicly deployed AI chatbot with a browser-based interface, powered by Meta's Llama 3.3 70B model via the Groq API and hosted on Netlify. Originally built with Flask and Ollama for local development, then migrated to a serverless architecture for public deployment.

**Live app:** [https://ai-powered-chat.netlify.app/](https://ai-powered-chat.netlify.app/)

## Tools and Technologies Used

### Deployed Version (Public)

- JavaScript (ES6+) — frontend
- Node.js — Netlify serverless function (backend)
- Groq API — LLM inference in the cloud
- Llama 3.3 70B (`llama-3.3-70b-versatile`)
- Netlify — hosting and serverless functions

### Local Development Version

- Python 3.10+
- Flask
- Flask-CORS
- Requests
- Ollama (local LLM runtime)
- Llama 3.2 model (`llama3.2:latest`)
- Docker (optional containerised setup)

### General

- HTML5 / CSS3
- Git and GitHub
- VS Code

## Key Features

- Publicly accessible browser-based chatbot interface
- Serverless backend — no server to maintain, scales automatically
- Multi-turn conversation memory (last 10 exchanges sent with each request)
- API key secured server-side, never exposed to the browser
- Local development mode using Flask + Ollama for offline use
- CORS enabled for frontend/backend communication

## Deploying to Netlify (Public)

### Prerequisites

- A [Groq API key](https://console.groq.com) (free)
- The project pushed to a GitHub repository

### Steps

1. Go to [app.netlify.com](https://app.netlify.com) → Add new site → Import from Git
2. Select your repository
3. Set **Base directory** to `LLM_application_chatbot`
4. Leave build command blank; set **Publish directory** to `.`
5. Go to Site Settings → Environment variables → add `GROQ_API_KEY` = your key
6. Deploy — your live URL will be `https://ai-powered-chat.netlify.app/`

---

## Running Locally (Flask + Ollama)

### Prerequisites

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

## API Endpoint (Local Flask Version)

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
	index.html              # Static HTML — served by Netlify
	netlify.toml            # Netlify config
	app.py                  # Flask backend (local development only)
	requirements.txt        # Python dependencies (local only)
	Dockerfile              # Docker setup (local only)
	netlify/
		functions/
			chatbot.js      # Serverless function — calls Groq API
	static/
		script.js
		css/
			style.css
	templates/
		index.html          # Flask template (local development only)
```

## Summary

Built a publicly deployed AI chatbot with a browser-based UI powered by Meta's Llama 3.3 70B via the Groq API. The backend runs as a Netlify serverless function, keeping the API key secure and the app free to host. Originally developed locally using Flask, Python, and Ollama, then migrated to a serverless architecture for public deployment.
