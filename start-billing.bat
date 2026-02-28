@echo off
echo Starting API Billing Tracker...

:: Change to the correct workspace directory
cd /d "%~dp0"

:: [OPTIONAL] Set the API key for the visual scraper (e.g. your OpenRouter key for GPT-4o-mini)
:: If you want to use the MiniMax visual scraper, uncomment and fill the line below:
:: set VISION_API_KEY=sk-or-v1-xxxxxxxxx

:: Start the Node server
echo Starting Node server on port 8099...
node billing-server.js

pause