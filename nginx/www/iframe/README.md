# 🤖✨ Chandru AI Chatbot
https://github.com/chandru-002/chatbot

A simple **web-based AI chatbot** UI built with **HTML, CSS, and JavaScript**. It uses **Google Gemini** (Generative Language API) to generate responses, and includes an emoji picker + image upload support.

## 🚀 Demo / Preview
Open `index.html` in your browser to see the chatbot UI.

## 🧰 Tech Stack
- 🌐 HTML / CSS / JavaScript
- 😄 Emoji picker: `emoji-mart` (CDN)
- 🧠 AI: Google Gemini (Generative Language API)

## ✅ Features
- 💬 Chat UI with toggle button
- 🤖 Bot typing indicator
- 😄 Emoji picker
- 🖼️ Image upload + send as inline data (base64)
- 🧾 Chat history is sent to the model for context

## 🏁 Getting Started
### 1) Clone
```bash
git clone https://github.com/Chandru2005-chandru/chatbot.git
cd chatbot
```

### 2) Run locally (Web)
Option A (simple):
- Just open `index.html` in your browser

Option B (recommended: local server):
```bash
# If you have Python installed
python -m http.server 8000
# then open http://localhost:8000
```

## 🔑 API Key Setup (Important)
Right now, the API key is **hard-coded** inside `script.js`. For security, you should:
- ❌ Never commit real API keys to GitHub
- ✅ Move the key to an environment variable or backend

### Suggested safer approach
- Create a small backend (Node/Python) that calls Gemini
- Keep the API key on the server

## 📱 APK
This repo also includes an Android APK file: `chandruai.apk`.

## 🛡️ Disclaimer
This project is for learning/demo purposes. Please secure API keys before using in production.

## 📄 License
Add a license if you plan to share this publicly (MIT is a common choice).
