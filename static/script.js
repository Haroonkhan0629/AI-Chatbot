// Store conversation history for multi-turn context
let savedpasttext = []; // Variable to store user messages
let savedpastresponse = []; // Variable to store bot responses
const conversationHistory = []; // Sent to backend for context-aware responses

// Get the Id of the talking container
// Get references to main UI elements
const messagesContainer = document.getElementById('messages-container');
const messageForm = document.getElementById('message-form');
const messageInput = document.getElementById('message-input');
//

// Function to creat the dialogue window
const addMessage = (message, role, imgSrc) => {
  // create elements in the dialogue window
  const messageElement = document.createElement('div');
  const textElement = document.createElement('p');
  messageElement.className = `message ${role}`;
  const imgElement = document.createElement('img');
  imgElement.src = `${imgSrc}`;
  // append the image and message to the message element
  messageElement.appendChild(imgElement);
  textElement.innerText = message;
  messageElement.appendChild(textElement);
  messagesContainer.appendChild(messageElement);
  // create the ending of the message
  var clearDiv = document.createElement("div");
  clearDiv.style.clear = "both";
  messagesContainer.appendChild(clearDiv);
};
//


// Calling the model
const sendMessage = async (message) => {
  // addMessage(message, 'user','user.jpeg');
  addMessage(message, 'user','../static/user.jpeg');
  // Loading animation
  const loadingElement = document.createElement('div');
  const loadingtextElement = document.createElement('p');
  loadingElement.className = `loading-animation`;
  loadingtextElement.className = `loading-text`;
  loadingtextElement.innerText = 'Loading....Please wait';
  messagesContainer.appendChild(loadingElement);
  messagesContainer.appendChild(loadingtextElement);

  // Send user message to Netlify Function backend
  async function makePostRequest(msg) {
    const url = '/.netlify/functions/chatbot';
    const requestBody = {
      prompt: msg,
      history: conversationHistory
    };
  
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      });
  
      const data = await response.json();
      // Handle the response data here
      console.log(data);
      return data;
    } catch (error) {
      // Handle any errors that occurred during the request
      console.error('Error:', error);
      return error
    }
  }
  
  // Wait for AI response
  var data = await makePostRequest(message);
  
  // Deleting the loading animation
  const loadanimation = document.querySelector('.loading-animation');
  const loadtxt = document.querySelector('.loading-text');
  loadanimation.remove();
  loadtxt.remove();

  // Display error or success message
  if (data.error) {
    // Handle the error here
    const errorMessage = JSON.stringify(data);
    // addMessage(errorMessage, 'error','Error.png');
    addMessage(errorMessage, 'error','../static/Error.png');
  } else {
    // Process the normal response here
    const responseMessage = data['response'];
    // addMessage(responseMessage, 'aibot','Bot_logo.png');
    addMessage(responseMessage, 'aibot','../static/Bot_logo.png');
  }
  
  // Save exchange to conversation history for next request
  if (!data.error) {
    conversationHistory.push({ role: 'user', content: message });
    conversationHistory.push({ role: 'assistant', content: data['response'] });
    // Keep last 10 exchanges (20 messages)
    if (conversationHistory.length > 20) conversationHistory.splice(0, 2);
  }
};
//

// Button to submit to the model and get the response
// Handle form submission when user sends a message
messageForm.addEventListener('submit', async (event) => {
  event.preventDefault(); // Prevent page reload
  const message = messageInput.value.trim();
  // Only send if message is not empty
  if (message !== '') {
    messageInput.value = ''; // Clear input field
    await sendMessage(message); // Send message to AI
  }
});
