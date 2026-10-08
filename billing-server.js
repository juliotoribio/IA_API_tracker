const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const minimaxScraper = require('./minimax-vision-scraper'); // Import our new scraper
const db = require('./db'); // SQLite database layer

const PORT = 8099; // Changed port to avoid any conflicts

const app = express();
app.use(express.json());

// Catch unhandled rejections/exceptions that might crash the server silently
process.on('uncaughtException', (err) => {
  console.error('CRITICAL ERROR (Uncaught Exception):', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('CRITICAL ERROR (Unhandled Rejection):', reason);
});

const DATA_FILE = path.join(__dirname, 'billing-data.json');

const PROVIDER_ENDPOINTS = {
  openrouter: {
    url: 'https://openrouter.ai/api/v1/credits',
    headers: (key) => ({ 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' })
  },
  deepseek: {
    url: 'https://api.deepseek.com/user/balance',
    headers: (key) => ({ 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' })
  },
  minimax: {
    url: 'https://api.minimax.chat/v1/account_balance',
    headers: (key) => ({ 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' })
  },
  kimi: {
    url: 'https://api.moonshot.ai/v1/users/me/balance', 
    headers: (key) => ({ 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' })
  },
  anthropic: {
    url: 'https://api.anthropic.com/v1/organizations',
    headers: (key) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' })
  },
  openai: {
    url: 'https://api.openai.com/v1/usage?period=monthly',
    headers: (key) => ({ 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' })
  },
  grok: {
    url: 'https://api.x.ai/v1/credits',
    headers: (key) => ({ 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' })
  },
  together: {
    url: 'https://api.together.ai/v1/billing',
    headers: (key) => ({ 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' })
  },
  google: {
    url: 'manual',
    headers: () => ({})
  }
};

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      // Migration: Add unique ID to existing providers
      let modified = false;
      data.providers.forEach(p => {
        if (!p.id) {
          p.id = p.type + '_' + Date.now() + Math.floor(Math.random() * 1000);
          modified = true;
        }
      });
      if (modified) saveData(data);
      return data;
    }
  } catch (e) {}
  return { providers: [] };
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

app.get('/api/providers', (req, res) => {
  const providers = db.getAllProviders();
  res.json(providers);
});

app.post('/api/providers', (req, res) => {
  const { type, apiKey, name, color, manualRecharged, groupId } = req.body;
  const id = db.upsertProvider({ type, apiKey, name, color, manualRecharged, groupId });
  res.json({ success: true, id });
});

app.delete('/api/providers/:type', (req, res) => {
  const { type } = req.params;
  db.deleteProvider(type);
  res.json({ success: true });
});

app.post('/api/providers/:type/manual_override', (req, res) => {
  const { type } = req.params;
  const { remaining, topped_up, used } = req.body;
  const prov = db.getProviderByType(type);
  if (prov) {
    db.recordSnapshot(prov.id, { remaining, topped_up, used });
  }
  res.json({ success: true });
});

app.get('/api/history/:type', (req, res) => {
  const prov = db.getProviderByType(req.params.type);
  if (!prov) return res.json([]);
  const days = parseInt(req.query.days) || 30;
  res.json(db.getDailyUsage(prov.id, days));
});

app.get('/api/models/:type', (req, res) => {
  const prov = db.getProviderByType(req.params.type);
  if (!prov) return res.json([]);
  res.json(db.getModelUsage(prov.id));
});

app.get('/api/billing/:type', async (req, res) => {
  const { type } = req.params;
  const data = loadData();
  const provider = data.providers.find(p => p.type === type);
  
  if (!provider?.apiKey) {
    return res.status(400).json({ error: 'No API key configured' });
  }

  const config = PROVIDER_ENDPOINTS[type];
  if (!config) {
    return res.status(400).json({ error: 'Unknown provider' });
  }

  try {
    let billing = {};

    if (type === 'minimax') {
      console.log(`[minimax] Triggering visual scraper...`);
      // Use scraper instead of API
      await minimaxScraper.takeScreenshot();
      const extracted = await minimaxScraper.extractBalanceWithVision();
      
      const remaining = extracted.remaining || 0;
      const currency = extracted.currency || 'USD';
      const topped_up = provider.manualRecharged > 0 ? provider.manualRecharged : remaining;
      const used = Math.max(0, topped_up - remaining);
      
      billing = { remaining, used, topped_up, currency };
    } else if (type === 'openai' || type === 'google') {
      console.log(`[${type}] Using manual tracking...`);
      billing = provider.billing || { remaining: 0, used: 0, topped_up: 0, currency: 'USD' };
    } else {
      let finalUrl = config.url;
      const response = await axios.get(finalUrl, {
        headers: config.headers(provider.apiKey)
      });
      console.log(`[${type}] Fetching from ${finalUrl}`);
      console.log(`[${type}] Response:`, JSON.stringify(response.data).substring(0, 500));
      
      if (type === 'deepseek') {
        const usd = response.data.balance_infos?.find(b => b.currency === 'USD');
        const cny = response.data.balance_infos?.find(b => b.currency === 'CNY');
        
        let remaining = 0;
        let currency = 'USD';
        
        if (cny && parseFloat(cny.total_balance) > 0) {
          remaining = parseFloat(cny.total_balance) || 0;
          currency = 'CNY';
        } else if (usd) {
          remaining = parseFloat(usd.total_balance) || 0;
        }
        
        const prevToppedUp = provider.billing?.topped_up || 0;
        const topped_up = provider.manualRecharged > 0 ? provider.manualRecharged : Math.max(prevToppedUp, 8.43, remaining);
        const used = Math.max(0, topped_up - remaining);
        billing = { remaining, used, topped_up, currency };
      } else if (type === 'openrouter') {
        const d = response.data.data || {};
        const topped_up = typeof d.total_credits !== 'undefined' ? d.total_credits : (d.credits || 0);
        const used = typeof d.total_usage !== 'undefined' ? d.total_usage : 0;
        const remaining = Math.max(0, topped_up - used);
        billing = { remaining, used, topped_up, currency: 'USD' };
      } else if (type === 'kimi') {
      const data = response.data.data || {};
      let remaining = 0;
      
      if (data.available_balance !== undefined) {
         remaining = parseFloat(data.available_balance);
      } else {
         const usd = data.available?.find(b => b.currency === 'USD');
         const cny = data.available?.find(b => b.currency === 'CNY');
         if (usd && parseFloat(usd.available) > 0) {
           remaining = parseFloat(usd.available);
         } else {
           remaining = parseFloat(cny?.available || 0);
         }
      }
      const topped_up = provider.manualRecharged > 0 ? provider.manualRecharged : remaining;
      const used = Math.max(0, topped_up - remaining);
      billing = { remaining, used, topped_up, currency: 'USD' }; // Force USD
    } else if (type === 'grok') {
        billing = { remaining: response.data.data?.credits || 0, currency: 'USD' };
      } else if (type === 'together') {
        billing = { remaining: response.data.data?.available_credits || 0, currency: 'USD' };
      }
    }
    
    provider.billing = billing;
    provider.lastFetch = new Date().toISOString();
    saveData(data);
    
    res.json(billing);
  } catch (error) {
    const status = error.response?.status || 500;
    // Fix [object Object] error display
    let message = error.message;
    if (error.response?.data) {
      if (typeof error.response.data === 'string') {
        message = error.response.data;
      } else if (error.response.data.error?.message) {
        message = error.response.data.error.message;
      } else if (error.response.data.message) {
        message = error.response.data.message;
      } else {
        message = JSON.stringify(error.response.data);
      }
    }
    console.error(`[${type}] Error:`, message);
    res.status(status).json({ error: message });
  }
});

app.get('/api/fetch-all', (req, res) => {
  res.redirect('/api/billing');
});

async function syncAllProviders() {
  const providers = db.getAllProviders();
  const results = [];
  
  for (const provider of providers) {
    if (!provider.apiKey) continue;
    
    const config = PROVIDER_ENDPOINTS[provider.type];
    if (!config) continue;
    
    try {
      let billing = {};
      if (provider.type === 'minimax') {
        console.log(`[minimax] Triggering visual scraper...`);
        await minimaxScraper.takeScreenshot();
        const extracted = await minimaxScraper.extractBalanceWithVision();
        const remaining = extracted.remaining || 0;
        const currency = extracted.currency || 'USD';
        const topped_up = provider.manualRecharged > 0 ? provider.manualRecharged : remaining;
        const used = Math.max(0, topped_up - remaining);
        billing = { remaining, used, topped_up, currency };
      } else if (provider.type === 'openai' || provider.type === 'google') {
        console.log(`[${provider.type}] Using manual tracking...`);
        billing = provider.billing || { remaining: 0, used: 0, topped_up: 0, currency: 'USD' };
      } else {
        let finalUrl = config.url;
        const response = await axios.get(finalUrl, {
          headers: config.headers(provider.apiKey)
        });
        
        if (provider.type === 'deepseek') {
          const usd = response.data.balance_infos?.find(b => b.currency === 'USD');
          const cny = response.data.balance_infos?.find(b => b.currency === 'CNY');
          
          let remaining = 0;
          let currency = 'USD';
          
          if (cny && parseFloat(cny.total_balance) > 0) {
            remaining = parseFloat(cny.total_balance) || 0;
            currency = 'CNY';
          } else if (usd) {
            remaining = parseFloat(usd.total_balance) || 0;
          }
          
          const prevToppedUp = provider.billing?.topped_up || 0;
          const topped_up = provider.manualRecharged > 0 ? provider.manualRecharged : Math.max(prevToppedUp, 8.43, remaining);
          const used = Math.max(0, topped_up - remaining);
          billing = { remaining, used, topped_up, currency };
        } else if (provider.type === 'openrouter') {
          const d = response.data.data || {};
          const topped_up = typeof d.total_credits !== 'undefined' ? d.total_credits : (d.credits || 0);
          const used = typeof d.total_usage !== 'undefined' ? d.total_usage : 0;
          const remaining = Math.max(0, topped_up - used);
          billing = { remaining, used, topped_up, currency: 'USD' };
        } else if (provider.type === 'kimi') {
          const data = response.data.data || {};
          let remaining = 0;
          
          if (data.available_balance !== undefined) {
             remaining = parseFloat(data.available_balance);
          } else {
             const usd = data.available?.find(b => b.currency === 'USD');
             const cny = data.available?.find(b => b.currency === 'CNY');
             if (usd && parseFloat(usd.available) > 0) {
               remaining = parseFloat(usd.available);
             } else {
               remaining = parseFloat(cny?.available || 0);
             }
          }
          const topped_up = provider.manualRecharged > 0 ? provider.manualRecharged : remaining;
          const used = Math.max(0, topped_up - remaining);
          billing = { remaining, used, topped_up, currency: 'USD' };
        } else if (provider.type === 'grok') {
          billing = { remaining: response.data.data?.credits || 0, currency: 'USD' };
        } else if (provider.type === 'together') {
          billing = { remaining: response.data.data?.available_credits || 0, currency: 'USD' };
        }
      }
      
      provider.billing = billing;
      provider.lastFetch = new Date().toISOString();
      db.recordSnapshot(provider.id, billing);
      results.push({ type: provider.type, billing });
    } catch (error) {
      let message = error.message;
      if (error.response?.data) {
        if (typeof error.response.data === 'string') {
          message = error.response.data;
        } else if (error.response.data.error?.message) {
          message = error.response.data.error.message;
        } else if (error.response.data.message) {
          message = error.response.data.message;
        } else {
          message = JSON.stringify(error.response.data);
        }
      }
      console.error(`[${provider.type}] Error:`, message);
      results.push({ type: provider.type, error: message });
    }
  }
  return results;
}

app.get('/api/billing', async (req, res) => {
  const results = await syncAllProviders();
  res.json(results);
});

app.use(express.static(__dirname));

app.get('/', (req, res) => {
  try {
    const htmlPath = path.join(__dirname, 'api-billing-tracker.html');
    const htmlContent = fs.readFileSync(htmlPath, 'utf8');
    res.setHeader('Content-Type', 'text/html');
    res.send(htmlContent);
  } catch (err) {
    console.error("Failed to load HTML file:", err);
    res.status(500).send("Error loading the page: " + err.message);
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`Open http://127.0.0.1:${PORT} in your browser`);
  
  // Schedule automatic periodic background snapshot every 30 minutes
  setInterval(async () => {
    console.log('[cron] Taking periodic snapshot of provider balances...');
    try {
      await syncAllProviders();
      console.log('[cron] Periodic snapshot completed.');
    } catch (err) {
      console.error('[cron] Error in periodic sync:', err.message);
    }
  }, 30 * 60 * 1000);
});
