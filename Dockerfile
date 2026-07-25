# Specify the parent image from which we build
FROM python:3.10

# Set the working directory
WORKDIR /LLM_application_chatbot

# This copies the requirements.txt file from the local directory to the current directory (.) in the container
COPY requirements.txt .

# Install the dependencies and packages in the requirements file
RUN pip install -r requirements.txt

# Copy every content from the local file to the image
COPY . .

# This informs Docker that the container will listen on port 5000 at runtime.
EXPOSE 5000

# Run with uvicorn — PORT is injected by Render (defaults to 5000 locally)
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-5000}"]
