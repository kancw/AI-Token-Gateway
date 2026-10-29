# OmniGateway: Enterprise AI Proxy & Token Governance Engine

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org)
[![Express](https://img.shields.io/badge/Framework-Express_4-blue.svg)](https://expressjs.com)
[![AI Provider](https://img.shields.io/badge/Model-Google_Gemini-orange.svg)](https://aistudio.google.com)
[![Database](https://img.shields.io/badge/Storage-SQLite_(WAL)-yellow.svg)](https://sqlite.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-purple.svg)](https://opensource.org/licenses/MIT)

A lightweight, production-grade reverse proxy designed to govern, monitor, and enforce budget tiers across Google Gemini LLM endpoints. Features real-time Server-Sent Events (SSE) streaming, cryptographic JWT role verification, and persistent per-user token allocation tracking with an interactive web UI.

---

## Architecture Overview

```
[ Interactive Web UI / Client App ]
                │
                ▼ (Bearer JWT Header Auth)
┌───────────────────────────────────────────────┐
│           OmniGateway Reverse Proxy           │
├───────────────────────────────────────────────┤
│ 1. Token & Role Verification (JWT Middleware) │
│ 2. Quota Check (SQLite Persistent Storage)    │
│ 3. Model Authorization Router                 │
└──────────────────────┬────────────────────────┘
                       │
                       ▼ (Secure Upstream Forwarding via x-goog-api-key)
         [ Google Gemini REST API (v1beta) ]
                       │
                       ▼ (SSE Stream Parser & Counter)
┌───────────────────────────────────────────────┐
│ 4. Real-time Chunks Piped to Client (SSE)     │
│ 5. Atomic Token Recording (WAL Mode SQLite)   │
└───────────────────────────────────────────────┘
```

## Key Technical Features

* **Direct Google Gemini API Integration**: Connects straight to the official Google Gemini API (including free-tier `gemini-2.5-flash` and `gemini-2.5-pro` from Google AI Studio).
* **Tier-Based Role Access Control (RBAC)**: Validates cryptographically signed JWT tokens on all requests, gating access to lightweight vs. flagship foundation models based on user subscription tiers.
* **Persistent Token Allocation**: Replaces in-memory state with an embedded SQLite engine operating in Write-Ahead Logging (WAL) mode for atomic usage tracking.
* **Zero-Latency SSE Streaming**: Pipes upstream model generation chunks straight to the browser with zero added latency, extracting official prompt and completion token counts upon completion.
* **Plug-and-Play Interactive UI**: Features an instant 1-click tier switcher, live token quota progress bar, conversational history, and markdown/code formatting.

## Quick Start (3 Steps)

### 1. Installation

```bash
git clone https://github.com/your-username/omni-ai-gateway.git
cd omni-ai-gateway
npm install
```

### 2. Configure Environment

Copy the example configuration:
```bash
cp .env.example .env
```

Get a free Gemini API key at [Google AI Studio](https://aistudio.google.com) and add it to your `.env` file:
```env
PORT=3000
JWT_SECRET=your_super_secret_signing_key_here
GEMINI_API_KEY=your_gemini_api_key_here
```

### 3. Launch the Gateway

```bash
npm start
```
Open **`http://localhost:3000`** in your browser to immediately test chat streaming and token tier enforcement.

## API Specification

### `POST /api/chat`
* **Headers**: `Authorization: Bearer <token>`, `Content-Type: application/json`
* **Body**:
  ```json
  {
    "query": "Explain what a reverse proxy does in 3 bullet points.",
    "model": "gemini-flash",
    "history": []
  }
  ```
* **Response**: `text/event-stream` (real-time chunks).

### `GET /api/usage`
* **Headers**: `Authorization: Bearer <token>`
* **Response**:
  ```json
  {
    "userId": "user_tier_3",
    "userTier": 3,
    "tierName": "Enterprise (Tier 3)",
    "allowedModels": ["gemini-flash", "gemini-pro"],
    "usage": {
      "gemini-flash": { "used": 1420, "limit": 2000000, "remaining": 1998580 },
      "gemini-pro": { "used": 0, "limit": 500000, "remaining": 500000 }
    }
  }
  ```

## License
MIT License. Created by Kan Cheuk Wang.
