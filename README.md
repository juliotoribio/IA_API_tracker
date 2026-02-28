# API Billing Tracker

A sleek, self-hosted dashboard to monitor your API usage and billing across multiple AI providers (OpenRouter, DeepSeek, OpenAI, Anthropic, Kimi, MiniMax, Grok, Together AI).

![Dashboard Preview](https://via.placeholder.com/800x400.png?text=API+Billing+Tracker+Dashboard)

## Features

- **Multi-Provider Support**: Track 8+ major AI providers in one unified dashboard.
- **Local & Secure**: All API keys are stored locally in your `billing-data.json`. No data is ever sent to a third-party server.
- **Auto & Manual Modes**: 
  - Automatically fetches remaining credits, usage, and total top-ups.
  - Allows manual tracking for providers that lack historical top-up APIs.
- **MiniMax Visual Scraper**: MiniMax PAYG doesn't offer a billing API. This tool includes a Puppeteer-based visual scraper that logs into your dashboard, takes a screenshot, and uses Vision AI (e.g., GPT-4o-mini via OpenRouter) to extract your exact remaining balance!
- **Currency Auto-Conversion**: Aggregates totals intelligently, converting CNY to USD (or vice-versa) based on real-time equivalent rates.

## Installation

### Prerequisites
- Node.js (v18+)

### 1. Clone the repository

```bash
git clone https://github.com/Maxaccurate/API-Billing-Tracker.git
cd API-Billing-Tracker
```

### 2. Install dependencies

```bash
npm install
```

### 3. Start the application

**On Windows:**
Simply double-click `start-billing.bat`.

**On Mac/Linux:**
```bash
node billing-server.js
```

Open your browser and navigate to `http://127.0.0.1:8099`.

## Setting up the MiniMax Visual Scraper (Optional)

Since MiniMax does not expose a billing API, we use a Headless Browser + Vision Model to read your balance. 

1. Edit `start-billing.bat` (or your terminal environment) and set `VISION_API_KEY` to an OpenRouter or OpenAI API key.
2. The default script uses `openai/gpt-4o-mini` via OpenRouter. You can change this in `minimax-vision-scraper.js`.
3. When you first refresh MiniMax, a browser window will open. **Log in manually**. The session will be saved locally (`.minimax_browser_data`), so future refreshes will be completely silent and automatic!

## Privacy

Your API keys are stored entirely in `billing-data.json` inside your local directory. Please make sure **never to commit** this file to a public repository. It is included in `.gitignore` by default.

## Contributing
Feel free to open issues or submit PRs to add new API providers or improve the dashboard UI.

## License
MIT License
