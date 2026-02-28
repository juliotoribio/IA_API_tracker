const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const USER_DATA_DIR = path.join(__dirname, '.minimax_browser_data');
const SCREENSHOT_PATH = path.join(__dirname, 'minimax-balance.png');

// You should set your OpenAI/OpenRouter API Key as an environment variable or hardcode it here
// We need a Vision model like gpt-4o, claude-3-5-sonnet, or gemini-1.5-pro
const VISION_API_KEY = process.env.VISION_API_KEY || ''; 
const VISION_PROVIDER = 'openrouter'; // or 'openai'

async function takeScreenshot() {
  console.log('Starting browser to capture MiniMax balance...');
  
  // Use a persistent user data directory so you only have to log in once
  const browser = await puppeteer.launch({
    headless: false, // Set to false so you can log in the first time
    userDataDir: USER_DATA_DIR,
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', // Use real Edge
    defaultViewport: null, // Use default window size
    args: [
      '--no-sandbox', 
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled' // Helps bypass some bot detection
    ]
  });

  const page = await browser.newPage();
  
  try {
    console.log('Navigating to MiniMax billing page...');
    await page.goto('https://platform.minimax.io/user-center/payment/balance', { 
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    // Wait to see if we hit a login page. If we are at the login page, we need to wait for the user to log in manually.
    if (page.url().includes('login')) {
      console.log('\n--- ATTENTION ---');
      console.log('Please log in manually in the opened browser window.');
      console.log('Waiting for you to log in and reach the balance page...\n');
      
      // Wait until the URL changes back to the balance page
      await page.waitForFunction(
        () => window.location.href.includes('/payment/balance'),
        { timeout: 300000 } // Wait up to 5 minutes for manual login
      );
      console.log('Login detected! Proceeding to capture...');
      // Give it a few seconds to load the balance data
      await new Promise(r => setTimeout(r, 5000)); 
    } else {
      // Already logged in, wait a bit for data to load
      await new Promise(r => setTimeout(r, 3000));
    }

    // Take screenshot of the page
    await page.screenshot({ path: SCREENSHOT_PATH, fullPage: false });
    console.log(`Screenshot saved to ${SCREENSHOT_PATH}`);

  } catch (error) {
    console.error('Failed to capture screenshot:', error);
    throw error;
  } finally {
    console.log('Closing browser...');
    await browser.close();
  }
}

async function extractBalanceWithVision() {
  if (!VISION_API_KEY) {
    throw new Error('VISION_API_KEY is not set. Cannot use vision model to extract balance.');
  }

  console.log('Sending screenshot to Vision AI for extraction...');
  const base64Image = fs.readFileSync(SCREENSHOT_PATH, { encoding: 'base64' });
  const dataUri = `data:image/png;base64,${base64Image}`;

  const prompt = `
Look at this screenshot of a billing dashboard. 
Find the "Available Balance" or total balance amount (in USD or CNY).
Only return a JSON object with two keys: "remaining" (number) and "currency" ("USD" or "CNY").
For example: {"remaining": 12.45, "currency": "USD"}
Do not return any other text, markdown formatting, or explanations. Only the raw JSON.`;

  try {
    let response;
    
    if (VISION_PROVIDER === 'openrouter') {
      response = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
        model: 'openai/gpt-4o-mini', // reliable vision model
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: dataUri } }
            ]
          }
        ]
      }, {
        headers: {
          'Authorization': `Bearer ${VISION_API_KEY}`,
          'Content-Type': 'application/json'
        }
      });
    }

    let textResponse = response.data.choices[0].message.content.trim();
    // Clean up markdown block if model added it
    if (textResponse.startsWith('```json')) {
      textResponse = textResponse.replace('```json', '').replace('```', '').trim();
    }
    if (textResponse.startsWith('```')) {
      textResponse = textResponse.replace(/```/g, '').trim();
    }

    const result = JSON.parse(textResponse);
    console.log('Extraction Result:', result);
    return result;

  } catch (error) {
    console.error('Failed to extract balance with Vision AI:', error.response?.data || error.message);
    throw error;
  }
}

async function run() {
  try {
    await takeScreenshot();
    
    // Uncomment when you add an API key
    if (VISION_API_KEY) {
      const balanceInfo = await extractBalanceWithVision();
      // Here you would save it to billing-data.json
    } else {
      console.log('Please set VISION_API_KEY environment variable to enable AI extraction.');
      console.log('For now, just the screenshot was taken. You can view it at: ', SCREENSHOT_PATH);
    }
  } catch (err) {
    console.error('Scraping failed:', err);
  }
}

// Run directly if called from command line
if (require.main === module) {
  run();
}

module.exports = { takeScreenshot, extractBalanceWithVision };