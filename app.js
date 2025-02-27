/*******************************************************
 * deploy.js
 *
 * 1) Run the server:
 *    node deploy.js
 *
 * 2) POST to http://localhost:3000/deploy with JSON:
 *    { "url": "https://some-site-with-html" }
 *
 * Also provide header:
 *    netlify-auth-token: <YOUR_NETLIFY_AUTH_TOKEN>
 *
 * The server will:
 *   - Fetch the HTML
 *   - Save as build/index.html
 *   - Zip build/ -> site.zip
 *   - Deploy to Netlify (using the token from request header and SITE_ID from .env)
 *   - Return ONLY a success message + final link in JSON
 *******************************************************/

require("dotenv").config();
const express = require("express");
const axios = require("axios");
const fs = require("fs-extra");
const path = require("path");
const { execSync } = require("child_process");
const { Spot } = require('@binance/connector');
const { ethers } = require('ethers');
const { Builder, By, until, Actions } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const AdmZip     = require("adm-zip");
const sharp      = require("sharp");
const cloudinary = require("cloudinary").v2;
const { Configuration, OpenAIApi } = require("openai");

// 1️⃣ Netlify site ID from .env (optional)
const NETLIFY_SITE_ID = process.env.NETLIFY_SITE_ID;

// Determine Netlify endpoint (existing site vs. new site)
const netlifyEndpoint = NETLIFY_SITE_ID
  ? `https://api.netlify.com/api/v1/sites`
  : "https://api.netlify.com/api/v1/sites/${NETLIFY_SITE_ID}/deploys";//https://api.netlify.com/api/v1/sites

// 2️⃣ Set up Express app
const app = express();
const PORT = 3000;

// Use JSON parsing
app.use(express.json());

// 3️⃣ POST /deploy: Expects { "url": "<HTML URL>" } and header "netlify-auth-token"
app.post("/deploy", async (req, res) => {
  try {
    // Read Netlify Auth Token from header (required)
    const netlifyAuthToken = req.headers["netlify-auth-token"];
    if (!netlifyAuthToken) {
      return res.status(400).json({ error: "Missing 'netlify-auth-token' header." });
    }

    // Read the URL from JSON body
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ error: "No 'url' provided in JSON body." });
    }

    console.log(`\n🌍 Fetching HTML from: ${url}`);

    // Define paths
    const baseFolder = __dirname;
    const buildFolder = path.join(baseFolder, "build");
    const indexFile = path.join(buildFolder, "index.html");
    const zipFile = path.join(baseFolder, "site.zip");

    // 4️⃣ Fetch the HTML
    const response = await axios.get(url);
    if (typeof response.data !== "string") {
      return res
        .status(400)
        .json({ error: "The requested URL did not return raw HTML content." });
    }

    // Ensure build folder exists
    fs.ensureDirSync(buildFolder);

    // 5️⃣ Save HTML to build/index.html
    fs.writeFileSync(indexFile, response.data, "utf8");
    console.log(`✅ HTML saved to: ${indexFile}`);

    // Remove old site.zip if it exists (optional)
    if (fs.existsSync(zipFile)) {
      fs.unlinkSync(zipFile);
    }

    // 6️⃣ Zip the build folder
    console.log("📦 Zipping build folder...");
    execSync(`zip -r "${zipFile}" "${buildFolder}"`, { stdio: "inherit" });
    console.log(`✅ site.zip created at: ${zipFile}`);

    // Read the zip into a buffer
    const zipBuffer = fs.readFileSync(zipFile);

    // 7️⃣ Deploy to Netlify using the token from headers
    console.log("🚀 Deploying ZIP to Netlify...");
    console.log("Netlify endpoint:", netlifyEndpoint);

    const deployResp = await axios.post(netlifyEndpoint, zipBuffer, {
      headers: {
        "Content-Type": "application/zip",
        Authorization: `Bearer ${netlifyAuthToken}`,
      },
    });

    const data = deployResp.data;
    console.log("\n🎉 Deployment success!");
    console.log("Netlify response data:", data);

    // 8️⃣ Send ONLY a success message + final link
    return res.json({
      message: "Deployment success!",
      link: data.deploy_url || data.url || null,
    });
  } catch (error) {
    console.error("❌ ERROR deploying:", error.response?.data || error.message || error);
    return res.status(500).json({
      error: "Deployment failed.",
      details: error.response?.data || error.message || error,
    });
  }
});

//---------------------Binance agent-------------------------------------------------//
const getClient = (apiKey, secretKey) => {
    return new Spot(apiKey, secretKey, { baseURL: 'https://testnet.binance.vision/' });
};

// Helper function to validate API keys in headers
const validateHeaders = (req, res, next) => {
    const { binanceapikey, binancesecretkey } = req.headers;
    if (!binanceapikey || !binancesecretkey) {
        return res.status(400).json({ message: "API key and secret key are required in headers" });
    }
    req.client = getClient(binanceapikey, binancesecretkey);
    next();
};

// Route to place a market order
app.post('/place-order', validateHeaders, async (req, res) => {
    const { symbol, quantity, quoteOrderQty } = req.body;

    if (!symbol || (!quantity && !quoteOrderQty)) {
        return res.status(400).json({ message: "Symbol and either quantity or quoteOrderQty are required" });
    }

    try {
        const order = await req.client.newOrder(symbol, 'BUY', 'MARKET', {
            quantity: quantity || undefined,
            quoteOrderQty: quoteOrderQty || undefined
        });
        res.json({ message: "Order placed successfully!", data: order.data });
    } catch (error) {
        res.status(500).json({ message: "Error placing order", error: error.message });
    }
});

// Route to place a limit order
app.post('/place-limit-order', validateHeaders, async (req, res) => {
    const { symbol, price, quantity, timeInForce = 'GTC' } = req.body;

    if (!symbol || !price || !quantity) {
        return res.status(400).json({ message: "Symbol, price, and quantity are required" });
    }

    try {
        const order = await req.client.newOrder(symbol, 'BUY', 'LIMIT', {
            price: price.toFixed(2),
            quantity: quantity.toFixed(2),
            timeInForce
        });
        res.json({ message: "Limit order placed successfully!", data: order.data });
    } catch (error) {
        res.status(500).json({ message: "Error placing limit order", error: error.message });
    }
});

// Route to fetch account balances
app.get('/fetch-balances', validateHeaders, async (req, res) => {
    try {
        const response = await req.client.account();
        const balances = response.data.balances.filter(balance => parseFloat(balance.free) > 0 || parseFloat(balance.locked) > 0);
        res.json({ message: "Balances fetched successfully", balances });
    } catch (error) {
        res.status(500).json({ message: "Error fetching balances", error: error.message });
    }
});

// Route to fetch open orders for a symbol
app.get('/open-orders/:symbol', validateHeaders, async (req, res) => {
    const { symbol } = req.params;

    try {
        const openOrders = await req.client.openOrders({ symbol });
        res.json({ message: "Open orders fetched successfully", data: openOrders.data });
    } catch (error) {
        res.status(500).json({ message: "Error fetching open orders", error: error.message });
    }
});

// Route to fetch all orders for a symbol
app.get('/all-orders/:symbol', validateHeaders, async (req, res) => {
    const { symbol } = req.params;
    const { orderId } = req.query;

    try {
        const allOrders = await req.client.allOrders(symbol, { orderId: orderId || undefined });
        res.json({ message: "All orders fetched successfully", data: allOrders.data });
    } catch (error) {
        res.status(500).json({ message: "Error fetching all orders", error: error.message });
    }
});

// Route to cancel a specific order
app.delete('/cancel-order/:symbol', validateHeaders, async (req, res) => {
    const { symbol } = req.params;
    const { orderId } = req.query;

    if (!orderId) {
        return res.status(400).json({ message: "orderId is required" });
    }

    try {
        const cancelOrder = await req.client.cancelOrder(symbol, orderId);
        res.json({ message: "Order canceled successfully", data: cancelOrder.data });
    } catch (error) {
        res.status(500).json({ message: "Error canceling order", error: error.message });
    }
});

// Route to cancel all open orders for a symbol
app.delete('/cancel-open-orders/:symbol', validateHeaders, async (req, res) => {
    const { symbol } = req.params;

    try {
        const openOrders = await req.client.openOrders({ symbol });
        const cancelPromises = openOrders.data.map(order => req.client.cancelOrder(symbol, order.orderId));
        await Promise.all(cancelPromises);

        res.json({ message: "All open orders canceled successfully" });
    } catch (error) {
        res.status(500).json({ message: "Error canceling open orders", error: error.message });
    }
});


//---------------------------------------TWITTER AGENT---------------------------//

const CLIENT_ID = process.env.CONSUMER_KEY; // Your Twitter API Client ID
const CLIENT_SECRET = process.env.CONSUMER_SECRET; // Your Twitter API Client Secret
const REDIRECT_URI = 'https://serverless.on-demand.io/apps/tweet/callback'; // Your callback URL
const TOKEN_URL = 'https://api.twitter.com/2/oauth2/token';

/**
 * Step 2: Exchange authorization code for access token
 */
async function getAccessToken(code, codeVerifier) {
    const headers = {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')
    };
    console.log('code verifier:', codeVerifier);

    const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: REDIRECT_URI,
        code_verifier: codeVerifier // Ensure you pass the code verifier here
    });

    try {
        const response = await axios.post(TOKEN_URL, body.toString(), { headers }); // Use axios to send POST request
        console.log('code verifier:', codeVerifier);
        return response.data; // Return the data from the response
    } catch (error) {
        console.error('Error fetching access token:', error.response ? error.response.data : error.message);
        throw error; // Re-throw error for handling in the callback
    }
}

app.get('/callback', async (req, res) => {
    console.log('Callback received:', req.query); // Log the query parameters
    const authorizationCode = req.query.code;
    const error = req.query.error;
    const codeVerifier = 'challenge'; // Ensure you have this value available
    
    if (error) {
        console.error('Error in callback:', error);
        res.send('Error: ' + error);
        return;
    }

    if (authorizationCode) {
        console.log('Authorization Code:', authorizationCode);
        
        // Call getAccessToken to exchange authorization code for access token
        try {
            const tokenResponse = await getAccessToken(authorizationCode, codeVerifier);
            console.log('Access Token Response:', tokenResponse);

            if (tokenResponse.access_token) {
                // Add the "Bearer " prefix to the token
                const bearerToken = `Bearer ${tokenResponse.access_token}`;
                console.log('Bearer Token:', bearerToken); // Ensure it logs correctly
                res.send(`Authorization successful! Access Token: ${bearerToken}`);
            } else {
                res.send('Failed to retrieve access token: ' + JSON.stringify(tokenResponse));
            }
        } catch (error) {
            console.error('Error getting access token:', error);
            res.send('Error retrieving access token. Please try again.');
        }
    } else {
        console.error('Authorization code not found:', req.query);
        res.send('Authorization code not found. Please try again.');
    }
});

async function writeTweet(accessToken, tweet) {
    const url = 'https://api.twitter.com/2/tweets';

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ text: tweet })
    });

    const data = await response.json();
    return data;
}

app.post("/post/tweet", async (req, res) => {
    console.log(req.body, "line 80");

    // Extract the access token from the Authorization header
    const authHeader = req.headers['authorization'];
    if (!authHeader) {
        return res.status(400).json({ error: 'Authorization header is missing.' });
    }

    // The token comes after "Bearer " in the Authorization header
    const access_token = authHeader.split(' ')[1];
    if (!access_token) {
        return res.status(400).json({ error: 'Access token is missing in Authorization header.' });
    }

    // Get the tweet text from the request body
    const { text } = req.body;

    try {
        // Call the function to post the tweet
        const tweetResponse = await writeTweet(access_token, text);
        console.log('Tweet response:', tweetResponse);

        res.json({ message: "Tweet sent successfully." });
    } catch (error) {
        console.error('Error posting tweet:', error);
        res.status(500).json({ error: 'Error posting tweet. Please try again.' });
    }
});

//----------------------------------uniswap-------------------------------------------------//

const routerAbi = JSON.parse(fs.readFileSync(path.join(__dirname, 'abi', 'IUniswapV3RouterABI.json'), 'utf8'));
const quoterAbi = JSON.parse(fs.readFileSync(path.join(__dirname, 'abi', 'IUniswapV3QuoterABI.json'), 'utf8'));

// Environment variables
const RPC_URL = process.env.RPC_URL;
const UNISWAP_V3_ROUTER_ADDRESS = "0xE592427A0AEce92De3Edee1F18E0157C05861564";
const QUOTER_ADDRESS = "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6";
const feeTiers = [500, 3000, 10000]; // Fee tiers in ascending order
const MAX_GAS_LIMIT = ethers.BigNumber.from(300000); // Upper limit for gas (300,000 units)

// WETH mainnet address
const WETH_ADDRESS = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

// Token mapping file
const tokenMap = JSON.parse(fs.readFileSync(path.join(__dirname, 'mapping.json'), 'utf8'));

/**
 * Finds the address of a token given its symbol or name.
 * Special case: if user says "eth", return WETH_ADDRESS.
 * @param {string} tokenStr Token name or symbol
 * @returns {string} Token address
 */
function findTokenAddress(tokenStr) {
  const t = tokenStr.toLowerCase();
  if (t === 'eth') {
    // Use WETH address for ETH swaps
    return WETH_ADDRESS;
  }

  for (const [address, info] of Object.entries(tokenMap)) {
    const nameMatch = info.name.toLowerCase() === t;
    const symbolMatch = info.symbol.toLowerCase() === t;
    if (nameMatch || symbolMatch) {
      return address;
    }
  }
  throw new Error(`Token not found: ${tokenStr}`);
}

/**
 * Gets the best quote for swapping tokens.
 * @param {object} provider Ethers.js provider instance
 * @param {string} tokenInAddress Address of input token
 * @param {string} tokenOutAddress Address of output token
 * @param {string} amountInWei Amount of input token in wei
 * @returns {object} Best fee tier and quoted output amount
 */
async function getBestQuote(provider, tokenInAddress, tokenOutAddress, amountInWei) {
  const quoter = new ethers.Contract(QUOTER_ADDRESS, quoterAbi, provider);
  for (let fee of feeTiers) {
    try {
      const amountOut = await quoter.callStatic.quoteExactInputSingle(
        tokenInAddress,
        tokenOutAddress,
        fee,
        amountInWei,
        0
      );
      console.log(`Fee tier ${fee} gives output: ${ethers.utils.formatUnits(amountOut, 18)}`);
      return { fee, amountOut };
    } catch (error) {
      console.error(`Fee tier ${fee} failed: ${error.message}`);
      continue; // Try the next fee tier
    }
  }
  throw new Error("No valid liquidity pool found.");
}

/**
 * Calculates slippage dynamically based on token volatility and user-defined limits.
 * @param {string} tokenIn Input token
 * @param {string} tokenOut Output token
 * @returns {number} Slippage tolerance
 */
function calculateSlippage(tokenIn, tokenOut) {
  const BASE_SLIPPAGE = 0.005; // 0.5%
  const MAX_SLIPPAGE = 0.03; // 3%
  if (tokenIn === 'weth' && tokenOut === 'usdt') {
    return BASE_SLIPPAGE; // Minimal slippage for stable pairs
  } else if (tokenIn === 'weth' || tokenOut === 'weth') {
    return Math.min(BASE_SLIPPAGE * 2, MAX_SLIPPAGE); // Adjust for volatility
  } else {
    return MAX_SLIPPAGE; // Higher slippage for illiquid pairs
  }
}

// API Endpoints

/**
 * Swap tokens endpoint.
 * Requires a private key in the Authorization header.
 * Example request:
 * curl -X POST http://localhost:8000/swap \
 *  -H "Content-Type: application/json" \
 *  -H "Authorization: 0xYOUR_PRIVATE_KEY" \
 *  -d '{"amountIn":"1","tokenIn":"eth","tokenOut":"dai"}'
 */
app.post('/swap', async (req, res) => {
  const { authorization } = req.headers;
  const { amountIn, tokenIn, tokenOut } = req.body;

  if (!authorization) return res.status(401).json({ error: "Private key required in Authorization header" });
  if (!amountIn || !tokenIn || !tokenOut) {
    return res.status(400).json({ error: "Missing required parameters in request body" });
  }

  try {
    const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(authorization, provider);

    const tokenInAddress = findTokenAddress(tokenIn);
    const tokenOutAddress = findTokenAddress(tokenOut);
    const amountInWei = ethers.utils.parseEther(amountIn);

    // If tokenIn is "eth", we send ETH as value and no ERC20 checks.
    let valueToSend = 0;
    if (tokenIn.toLowerCase() === 'eth') {
      valueToSend = amountInWei;
    } else {
      // If tokenIn is an ERC-20, we must have balance and allowance
      const tokenContract = new ethers.Contract(tokenInAddress, [
        "function allowance(address owner, address spender) view returns (uint256)",
        "function balanceOf(address owner) view returns (uint256)",
        "function approve(address spender, uint256 amount) public returns (bool)"
      ], wallet);

      // Check balance
      const balance = await tokenContract.balanceOf(wallet.address);
      if (balance.lt(amountInWei)) {
        return res.status(400).json({ error: "Insufficient token balance." });
      }

      // Check allowance
      const allowance = await tokenContract.allowance(wallet.address, UNISWAP_V3_ROUTER_ADDRESS);
      if (allowance.lt(amountInWei)) {
        const approveTx = await tokenContract.approve(UNISWAP_V3_ROUTER_ADDRESS, ethers.constants.MaxUint256);
        await approveTx.wait();
        console.log("Approval complete.");
      }
    }

    // Get the best quote
    const { fee, amountOut } = await getBestQuote(provider, tokenInAddress, tokenOutAddress, amountInWei);
    const dynamicSlippage = calculateSlippage(tokenIn.toLowerCase(), tokenOut.toLowerCase());
    const amountOutMinimum = amountOut.mul(100 - (dynamicSlippage * 100)).div(100);

    const router = new ethers.Contract(UNISWAP_V3_ROUTER_ADDRESS, routerAbi, wallet);

    const params = {
      tokenIn: tokenInAddress,
      tokenOut: tokenOutAddress,
      fee,
      recipient: wallet.address,
      deadline: Math.floor(Date.now() / 1000) + 300,
      amountIn: amountInWei,
      amountOutMinimum,
      sqrtPriceLimitX96: 0
    };

    // Execute the transaction
    // If tokenIn was ETH, we supply `value: amountInWei`, else `value: 0`.
    const swapTx = await router.exactInputSingle(params, {
      gasLimit: MAX_GAS_LIMIT,
      value: valueToSend
    });
    const receipt = await swapTx.wait();
    res.status(200).json({ transactionHash: receipt.transactionHash });
  } catch (error) {
    console.error("Error executing swap:", error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Quote tokens endpoint.
 * Provides the estimated amount of output token for a given input token amount.
 */
app.post('/quote', async (req, res) => {
  const { amountIn, tokenIn, tokenOut } = req.body;

  if (!amountIn || !tokenIn || !tokenOut) {
    return res.status(400).json({ error: "Missing required parameters in request body" });
  }

  try {
    const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
    const tokenInAddress = findTokenAddress(tokenIn);
    const tokenOutAddress = findTokenAddress(tokenOut);
    const amountInWei = ethers.utils.parseEther(amountIn);

    const { fee, amountOut } = await getBestQuote(provider, tokenInAddress, tokenOutAddress, amountInWei);

    const amountOutFormatted = ethers.utils.formatUnits(amountOut, 18);
    return res.status(200).json({ feeTier: fee, amountOut: amountOutFormatted });
  } catch (error) {
    console.error(error.message);
    return res.status(500).json({ error: error.message });
  }
});


//-----------------------------makemytrip agent------------------------------------//
/**
 * Helper function to type text one character at a time.
 * @param {WebElement} element The Selenium element to type into
 * @param {string} text The text to type
 * @param {number} delayMs Delay (ms) between each character
 * @param {WebDriver} driver The Selenium driver (needed for sleeps)
 */
async function typeSlowly(element, text, delayMs, driver) {
    for (const char of text) {
      await element.sendKeys(char);
      await driver.sleep(delayMs);
    }
  }
  
  /**
   * Helper function to take screenshots.
   * @param {WebDriver} driver The Selenium driver
   * @param {string} filename The filename for the screenshot
   */
  async function takeScreenshot(driver, filename) {
    const image = await driver.takeScreenshot();
    fs.writeFileSync(filename, image, 'base64');
    console.log(`Screenshot saved as ${filename}`);
  }
  
  /**
   * Helper function to retry an asynchronous action multiple times.
   * @param {Function} action - The asynchronous function to execute.
   * @param {number} retries - Number of retry attempts.
   * @param {number} delayMs - Delay (ms) between attempts.
   * @returns {Promise<*>} - Resolves with the action's result or rejects after all retries fail.
   */
  async function retryAction(action, retries = 5, delayMs = 2000) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        return await action();
      } catch (error) {
        console.warn(`Attempt ${attempt} failed: ${error.message}`);
        if (attempt === retries) {
          throw new Error(`All ${retries} attempts failed.`);
        }
        console.log(`Retrying in ${delayMs / 1000} seconds...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }
  
  app.get('/scrape', async (req, res) => {
    console.log("Incoming /scrape request...");
  
    // Extract query params
    const {
      firstName,
      lastName,
      email,
      mobile,
      panNumber,
      upiId
    } = req.query;
  
    // Basic validation
    if (!firstName || !lastName || !email || !mobile || !panNumber) {
      console.error("Missing required query parameters for booking.");
      return res.status(400).send("Missing required query parameters for booking.");
    }
  
    let driver;
    try {
      console.log("Launching Selenium WebDriver...");
      const chromeOptions = new chrome.Options();
      chromeOptions.addArguments('--start-maximized'); // Launch browser maximized
      // Uncomment the following line to run in headless mode
      // chromeOptions.addArguments('--headless');
  
      driver = await new Builder()
        .forBrowser('chrome')
        .setChromeOptions(chromeOptions)
        .build();
      console.log("Browser launched.");
  
      // 1) Navigate to MMT Delhi hotels page
      console.log("Navigating to MMT Delhi hotels...");
      await driver.get("https://www.makemytrip.com/hotels-international/united_arab_emirates/abu_dhabi-hotels/");
      await driver.wait(until.elementLocated(By.css('body')), 60000);
      console.log("Main listing page loaded.");
  
      // 2) Wait for the first hotel listing
      console.log("Waiting for #Listing_hotel_0...");
      const hotelListing = await driver.wait(
        until.elementLocated(By.css('#Listing_hotel_0')),
        60000
      );
      await driver.wait(
        until.elementIsVisible(hotelListing),
        60000
      );
      console.log("Hotel listing is visible.");
  
      // 3) Click the first hotel listing and handle new tab
      console.log("Clicking the first hotel listing...");
      const oldTabs = await driver.getAllWindowHandles();
      await hotelListing.click();
  
      console.log("Waiting 3 seconds to see if a new tab opens...");
      await driver.sleep(3000);
  
      const newTabs = await driver.getAllWindowHandles();
      let detailTab = await driver.getWindowHandle();
      if (newTabs.length > oldTabs.length) {
        const diff = newTabs.filter(x => !oldTabs.includes(x));
        if (diff.length) detailTab = diff[0];
      }
      await driver.switchTo().window(detailTab);
      console.log("Switched to detail page tab.");
  
      // Take screenshot after switching tabs
      await takeScreenshot(driver, 'after_switching_tabs.png');
  
      // 4) Wait for detail page to load
      console.log("Waiting for <body> on the detail page...");
      await driver.wait(until.elementLocated(By.css('body')), 60000);
      console.log("Detail page loaded.");
  
      // 5) Click the 'Search' button if present
      console.log("Looking for #hsw_search_button...");
      try {
        const searchBtn = await driver.wait(
          until.elementLocated(By.css('#hsw_search_button')),
          15000
        );
        await driver.wait(until.elementIsVisible(searchBtn), 15000);
        await searchBtn.click();
        console.log("Search button clicked.");
  
        // Take screenshot after clicking search
        await takeScreenshot(driver, 'after_click_search.png');
      } catch {
        console.log("No search button or not clickable. Continuing...");
      }
      await driver.sleep(3000);
  
      // 6) Click "BOOK THIS NOW"
      console.log("Looking for .bkngOption__cta (BOOK THIS NOW)...");
      try {
        const bookThisNowBtn = await driver.wait(
          until.elementLocated(By.css('.bkngOption__cta')),
          15000
        );
        await driver.wait(until.elementIsVisible(bookThisNowBtn), 15000);
        await bookThisNowBtn.click();
        console.log("BOOK THIS NOW clicked.");
  
        // Take screenshot after clicking BOOK THIS NOW
        await takeScreenshot(driver, 'after_click_book_this_now.png');
      } catch (err) {
        console.error("BOOK THIS NOW direct click failed, trying JS:", err);
        await driver.executeScript(() => {
          const btn = document.querySelector('.bkngOption__cta');
          if (btn) btn.click();
        });
        console.log("BOOK THIS NOW clicked via JS injection.");
  
        // Take screenshot after JS injection click
        await takeScreenshot(driver, 'after_js_click_book_this_now.png');
      }
      await driver.sleep(2000);
  
      // 7) Fill traveler form (slowly)
      console.log("Filling traveler form (typing slowly)...");
      const fNameInput = await driver.wait(
        until.elementLocated(By.css('#fName')),
        15000
      );
      await driver.wait(until.elementIsVisible(fNameInput), 15000);
      await typeSlowly(fNameInput, firstName, 300, driver);
  
      const lNameInput = await driver.findElement(By.css('#lName'));
      await typeSlowly(lNameInput, lastName, 300, driver);
  
      const emailInput = await driver.findElement(By.css('#email'));
      await typeSlowly(emailInput, email, 200, driver);
  
      const mobileInput = await driver.findElement(By.css('#mNo'));
      await typeSlowly(mobileInput, mobile, 200, driver);
      console.log("Traveler details typed slowly.");
  
      // Take screenshot after filling traveler details
      await takeScreenshot(driver, 'after_filling_traveler_details.png');
  
      // 8) Fill PAN Number if the field appears
      console.log("Checking if 'ENTER PAN HERE' input appears...");
      try {
        const panField = await driver.wait(
          until.elementLocated(By.css('input[placeholder="ENTER PAN HERE"]')),
          5000
        );
        await typeSlowly(panField, panNumber, 200, driver);
        console.log(`PAN field found and typed slowly: ${panNumber}`);
  
        // Take screenshot after entering PAN
        await takeScreenshot(driver, 'after_filling_pan.png');
      } catch {
        console.log("No new PAN field found. Moving on...");
      }
  
      // 9) Click Terms & Conditions checkbox
      console.log("Clicking T&C checkbox...");
      try {
        const tncCheckbox = await driver.findElement(By.css('.checkboxWithLblWpr__label'));
        await tncCheckbox.click();
        console.log("T&C clicked.");
  
        // Take screenshot after clicking T&C
        await takeScreenshot(driver, 'after_clicking_tnc.png');
      } catch {
        console.log("T&C checkbox not found, skipping...");
      }
  
      // 10) Click "Pay Now"
      console.log("Looking for Pay Now button (.btnContinuePayment.primaryBtn.capText)...");
      try {
        const payNowBtn = await driver.wait(
          until.elementLocated(By.css('.btnContinuePayment.primaryBtn.capText')),
          15000
        );
        await driver.wait(until.elementIsVisible(payNowBtn), 15000);
        await payNowBtn.click();
        console.log("Pay Now clicked.");
  
        // Take screenshot after clicking Pay Now
        await takeScreenshot(driver, 'after_clicking_pay_now.png');
      } catch (error) {
        console.error("Failed to click Pay Now:", error);
      }
  
      // 11) Wait for payment options to load
      console.log("Waiting for .payment__options__tab...");
      await driver.wait(until.elementLocated(By.css('.payment__options__tab')), 30000);
      await driver.wait(
        until.elementIsVisible(driver.findElement(By.css('.payment__options__tab'))),
        30000
      );
      console.log("Payment options tab is visible.");
  
      // Take screenshot after payment options load
      await takeScreenshot(driver, 'after_payment_options_loaded.png');
  
      // 12) Scroll down to reveal UPI fields
      console.log("Scrolling down to find UPI fields...");
      await driver.executeScript("window.scrollBy(0, 600);");
      await driver.sleep(1000);
  
      // 13) Enter UPI ID if provided
      if (upiId) {
        console.log(`Entering UPI ID slowly: ${upiId}`);
        const upiInput = await driver.wait(
          until.elementLocated(By.css('#inputVpa')),
          15000
        );
        await driver.wait(until.elementIsVisible(upiInput), 15000);
        await typeSlowly(upiInput, upiId, 250, driver);
        console.log("UPI ID entered slowly.");
  
        // Take screenshot after entering UPI
        await takeScreenshot(driver, 'after_filling_upi.png');
      } else {
        console.log("No UPI ID provided, skipping UPI step.");
      }
  
      // 14, 15, 16) Continuous Loop: Click "Verify and Pay" -> Click "SKIP" -> Repeat until "SKIP" no longer appears
      console.log("Starting continuous loop: Click 'Verify and Pay' -> Click 'SKIP' -> Repeat...");
  
      // Define the maximum number of iterations to prevent infinite loops
      const MAX_ITERATIONS = 10;
      let iterationLoop = 0;
      let skipExists = true;
  
      while (skipExists && iterationLoop < MAX_ITERATIONS) {
        iterationLoop++;
        console.log(`\n--- Iteration ${iterationLoop} ---`);
  
        // Step 1: Click "Verify and Pay" with enhanced function
        try {
          console.log("Looking for final pay button (.prime__btn.paynow__btn)...");
          
          // Define the action to click "Verify and Pay"
          const clickVerifyPay = async () => {
            const finalPayBtn = await driver.wait(
              until.elementLocated(By.css('.prime__btn.paynow__btn')),
              15000
            );
            await driver.wait(until.elementIsVisible(finalPayBtn), 15000);
  
            // Scroll into view
            await driver.executeScript("arguments[0].scrollIntoView({ behavior: 'smooth', block: 'center' });", finalPayBtn);
            await driver.sleep(1000); // Wait for scrolling
  
            // Try clicking using Actions API
            try {
              const actions = driver.actions({ async: true });
              await actions.move({ origin: finalPayBtn }).pause(500).click().perform();
              console.log("Clicked 'Verify and Pay' using Actions API.");
            } catch (error) {
              console.warn("Actions API click failed, attempting JavaScript click.");
              await driver.executeScript("arguments[0].click();", finalPayBtn);
              console.log("Clicked 'Verify and Pay' using JavaScript.");
            }
  
            // Take screenshot after clicking
            await takeScreenshot(driver, `after_click_verify_pay_iter_${iterationLoop}.png`);
          };
  
          // Retry clicking "Verify and Pay" up to 5 times with 2-second intervals
          await retryAction(clickVerifyPay, 5, 2000);
  
          console.log("Final Payment Request (verify/pay) clicked.");
        } catch (error) {
          console.error(`Failed to click 'Verify and Pay' on iteration ${iterationLoop}:`, error);
          break; // Exit the loop on failure
        }
  
        // Step 2: Handle "SKIP" Button with retries
        try {
          console.log("Waiting for OTP modal with 'SKIP' button...");
          const otpModal = await driver.wait(
            until.elementLocated(By.css('section[data-cy="CommonModal_2"]')),
            15000
          );
          console.log("OTP modal appeared.");
  
          // Wait briefly to ensure the 'SKIP' button is loaded
          await driver.sleep(2000);
  
          // Define the action to click SKIP
          const clickSkip = async () => {
            const skipSpan = await driver.findElement(By.xpath("//section[@data-cy='CommonModal_2']//span[normalize-space()='SKIP']"));
            await skipSpan.click();
            console.log("Clicked 'SKIP' button.");
          };
  
          // Retry clicking SKIP up to 5 times with 2-second intervals
          await retryAction(clickSkip, 5, 2000);
  
          // Take screenshot after clicking SKIP
          await takeScreenshot(driver, `after_click_skip_otp_iter_${iterationLoop}.png`);
  
          // Wait for modal to close
          await driver.wait(
            until.stalenessOf(await driver.findElement(By.xpath("//section[@data-cy='CommonModal_2']//span[normalize-space()='SKIP']"))),
            10000
          );
          console.log("OTP modal closed after clicking 'SKIP'.");
  
          // Continue to the next iteration
        } catch (err) {
          console.log("No OTP modal or 'SKIP' button found. Assuming payment can proceed.");
          skipExists = false; // Exit the loop as "SKIP" is no longer present
        }
      }
  
      if (iterationLoop >= MAX_ITERATIONS) {
        console.warn(`Reached maximum iterations (${MAX_ITERATIONS}). Proceeding without further attempts.`);
      }
  
      console.log("\n--- Loop Ended ---");
  
      // 17) Wait and Close Browser
      console.log("All done. Waiting 30 seconds to observe...");
      await driver.sleep(30000);
  
      console.log("Flow completed. Closing browser...");
      await driver.quit();
      return res.status(200).send("Kindly approve the payment request, and the booking details will be shared with you at the email address that you provided.");
    } catch (error) {
      console.error("Error during scraping and booking:", error);
      if (driver) {
        try {
          await driver.quit();
        } catch {}
      }
      return res.status(500).send("An error occurred during scraping and booking.");
    }
  });

//-------------------------------------------html agent-------------------------------------------

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
  
  // A helper function that tries to compress an image buffer
  // under the target size by lowering quality in steps.
  async function compressImageToUnder(buffer, targetSizeKB = 250) {
    let quality = 90; // start at 90% JPEG quality
    while (quality > 10) {
      const compressed = await sharp(buffer)
        .jpeg({ quality, force: true })
        .toBuffer();
      const sizeKB = Math.round(compressed.length / 1024);
      if (sizeKB <= targetSizeKB) {
        console.log(`Compression success at quality=${quality}, size=${sizeKB}KB`);
        return compressed;
      }
      quality -= 10; // lower quality if still too big
    }
    // If we exit the loop, just return final attempt at ~10% quality
    console.log(`Could not get below ${targetSizeKB}KB, returning last attempt.`);
    return await sharp(buffer).jpeg({ quality: 10, force: true }).toBuffer();
  }
  
  // Download, compress, upload to Cloudinary, return new URL
  async function fetchCompressUpload(originalUrl) {
    try {
      // 1) Download the image as array buffer
      const resp = await axios.get(originalUrl, { responseType: "arraybuffer" });
      const originalBuffer = Buffer.from(resp.data);
      console.log("Original size (KB) =", Math.round(originalBuffer.length / 1024));
  
      // 2) Compress
      const compressedBuffer = await compressImageToUnder(originalBuffer, 250);
      console.log("Compressed size (KB) =", Math.round(compressedBuffer.length / 1024));
  
      // 3) Upload to Cloudinary
      const uploadResult = await new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
          { folder: "compressed-images" }, // optional folder
          (error, result) => {
            if (error) reject(error);
            else resolve(result);
          }
        );
        uploadStream.end(compressedBuffer);
      });
  
      console.log("Cloudinary upload success =>", uploadResult.secure_url);
      return uploadResult.secure_url;
    } catch (err) {
      console.error("Error in fetchCompressUpload:", err.message);
      throw new Error(`Failed to compress+upload image from URL: ${originalUrl}`);
    }
  }
  
  // ----------------------------------------------------
  // 1) SETUP OPENAI
  // ----------------------------------------------------
  const openaiConfig = new Configuration({
    apiKey: process.env.OPENAIA_API_KEY || process.env.OPENAI_API_KEY, 
  });
  const openai = new OpenAIApi(openaiConfig);
  
  // ----------------------------------------------------
  // 2) NETLIFY DEPLOY FUNCTION
  //    We now read netlifySiteId from the request headers
  // ----------------------------------------------------
  async function deployHtmlToNetlify(htmlString, netlifyToken, netlifySiteId) {
    console.log("deployHtmlToNetlify: Starting deploy to Netlify...");
  
    if (!netlifyToken) {
      throw new Error("Missing Netlify Auth Token in request header!");
    }
    if (!netlifySiteId) {
      throw new Error("Missing Netlify Site ID in request header!");
    }
  
    // Zip index.html in memory
    console.log("deployHtmlToNetlify: Zipping HTML in memory...");
    const zip = new AdmZip();
    zip.addFile("index.html", Buffer.from(htmlString, "utf8"));
    const zipBuffer = zip.toBuffer();
    console.log("deployHtmlToNetlify: zip size =", zipBuffer.length, "bytes");
  
    // Deploy to Netlify
    const url = `https://api.netlify.com/api/v1/sites/${netlifySiteId}/deploys`;
    console.log("deployHtmlToNetlify: POST ->", url);
  
    const response = await axios.post(url, zipBuffer, {
      headers: {
        "Content-Type": "application/zip",
        Authorization: `Bearer ${netlifyToken}`,
      },
    });
  
    const deployUrl = response.data.deploy_url || response.data.url;
    console.log("deployHtmlToNetlify: SUCCESS, Netlify URL =", deployUrl);
    return deployUrl;
  }
  
  // ----------------------------------------------------
  // 3) HELPER: GENERATE HTML FROM PARSED JSON
  // ----------------------------------------------------
  
  // Default testimonial images if none provided
  const DEFAULT_T1 =
    "https://media.istockphoto.com/id/1329039896/photo/young-doctor-asking-senior-impaired-male-Client-in-wheelchair-to-sign-insurance-policy-at.jpg";
  const DEFAULT_T2 = "https://picsum.photos/80/80?random=203";
  const DEFAULT_T3 = "https://picsum.photos/80/80?random=201";
  
  function generateLandingPageHtml(parsedData) {
    console.log("generateLandingPageHtml: Building final HTML...");
  
    const {
      websiteNiche,
      doctorDetails,
      pageLinks = [],
      images = [],
      testimonialImages = [],
      faqs = [],
    } = parsedData;
  
    if (!websiteNiche || !doctorDetails || !doctorDetails.name) {
      throw new Error("Missing required fields: websiteNiche, doctorDetails.name, etc.");
    }
  
    // Hero/About image
    const mainImage = images[0] || "https://via.placeholder.com/1200x600?text=No+Hero+Image";
  
    // Arrays
    const specializationList = Array.isArray(doctorDetails.specialization)
      ? doctorDetails.specialization
      : [];
    const achievementsList = Array.isArray(doctorDetails.achievements)
      ? doctorDetails.achievements
      : [];
    const descriptionText = doctorDetails.description || "";
  
    // Testimonial images (fallback to defaults)
    const t1 = testimonialImages[0] || DEFAULT_T1;
    const t2 = testimonialImages[1] || DEFAULT_T2;
    const t3 = testimonialImages[2] || DEFAULT_T3;
  
    // Build final HTML string
    const html = `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Luxury Services – ${doctorDetails.name} | ${websiteNiche.toUpperCase()} Prestige</title>
    <meta name="description" content="${doctorDetails.name} is a leading specialist in the ${websiteNiche} field. This page showcases specializations, achievements, and more." />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  
    <!-- Bootstrap 5 CSS -->
    <link
      href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css"
      rel="stylesheet"
    >
    <!-- Bootstrap Icons (for styling bullet points) -->
    <link
      rel="stylesheet"
      href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.10.5/font/bootstrap-icons.css"
    >
    <!-- AOS (Animate On Scroll) CSS -->
    <link
      rel="stylesheet"
      href="https://cdn.jsdelivr.net/npm/aos@2.3.1/dist/aos.css"
    />
    <!-- Google Fonts -->
    <link rel="preconnect" href="https://fonts.gstatic.com" />
    <link
      href="https://fonts.googleapis.com/css2?family=Poppins:wght@300;500;700&display=swap"
      rel="stylesheet"
    >
  
    <style>
      body {
        font-family: 'Poppins', sans-serif;
        color: #333;
        background-color: #f9f9f9;
        overflow-x: hidden;
      }
      .navbar-brand {
        font-weight: 700;
      }
      /* Hero */
      .hero-section {
        position: relative;
        height: 75vh;
        background: url('${mainImage}') center center / cover no-repeat fixed;
        display: flex;
        align-items: center;
        justify-content: center;
        color: #fff;
        text-shadow: 2px 2px 6px rgba(0,0,0,0.5);
      }
      .hero-overlay {
        position: absolute;
        top: 0; right: 0; bottom: 0; left: 0;
        background: rgba(0,0,0,0.4);
      }
      .hero-content {
        position: relative;
        text-align: center;
        z-index: 2;
      }
      .hero-content h1 {
        font-size: 3rem;
        font-weight: 700;
      }
      .hero-content p {
        font-size: 1.3rem;
        font-weight: 300;
        margin-top: 0.5rem;
      }
      /* CTA Section */
      .cta-section {
        background: linear-gradient(135deg, #15aabf, #2fbfac);
        color: #fff;
        padding: 3rem 0;
        text-align: center;
      }
      .cta-section h2 {
        font-weight: 700;
        margin-bottom: 1rem;
      }
      .cta-section .btn-cta {
        background-color: #fff;
        color: #15aabf;
        font-weight: 600;
        border: none;
        padding: 0.75rem 1.5rem;
        border-radius: 50px;
        transition: background-color 0.3s ease;
      }
      .cta-section .btn-cta:hover {
        background-color: #eee;
      }
  
      /* Enhanced bullet styling for lists */
      .list-group-item {
        border: 0;
        padding-left: 0;
      }
      .list-group-item i {
        color: #2fbfac;
        margin-right: 0.5rem;
      }
  
      /* Testimonials */
      .testimonial-carousel .carousel-item {
        padding: 2rem;
      }
      .testimonial-carousel .carousel-item img {
        width: 80px;
        height: 80px;
        object-fit: cover;
        border-radius: 50%;
      }
      .testimonial-carousel .carousel-item blockquote {
        font-style: italic;
        margin: 1.5rem 0;
      }
  
      /* FAQ Section */
      .faq-section {
        background-color: #fff;
        padding: 3rem 0;
        margin-bottom: 3rem;
      }
      /* Description Section styling (within About) */
      .description-box {
        background: #fff3e6;
        border: 1px solid #ffd9b3;
        padding: 1.5rem;
        border-radius: 5px;
        margin-bottom: 1.5rem;
        line-height: 1.8;
        min-height: 220px;
        width: 95%;
        margin: 0 auto 1.5rem auto;
      }
      /* Appointment Form styling */
      .appointment-card {
        border: none;
        box-shadow: 0 2px 6px rgba(0,0,0,0.1);
        border-radius: 8px;
      }
      .appointment-card .card-body {
        padding: 2rem;
      }
      /* Footer */
      footer {
        background-color: #222;
        color: #bbb;
        padding: 2rem 0;
        text-align: center;
      }
      footer p {
        margin: 0;
      }
      /* AOS animations */
      [data-aos] {
        transition: transform 0.6s ease, opacity 0.6s ease;
      }
    </style>
  </head>
  <body>
    <!-- Navbar -->
    <nav class="navbar navbar-expand-lg navbar-dark bg-dark" data-aos="fade-down">
      <div class="container">
        <a class="navbar-brand" href="#">${doctorDetails.name}</a>
        <button class="navbar-toggler" type="button" data-bs-toggle="collapse" data-bs-target="#navbarMenu">
          <span class="navbar-toggler-icon"></span>
        </button>
        <div class="collapse navbar-collapse" id="navbarMenu">
          <ul class="navbar-nav ms-auto">
            ${pageLinks.map(link => `
              <li class="nav-item">
                <a class="nav-link" href="/${link}">${link.replace('-', ' ')}</a>
              </li>
            `).join('')}
          </ul>
        </div>
      </div>
    </nav>
    
    <!-- Hero -->
    <section class="hero-section">
      <div class="hero-overlay"></div>
      <div class="hero-content" data-aos="zoom-in">
        <h1> ${doctorDetails.name}</h1>
        <p>Leading Specialist in ${websiteNiche}</p>
        <button class="btn btn-light mt-3" onclick="document.getElementById('appointment').scrollIntoView({ behavior: 'smooth' });">
          Book an Appointment
        </button>
      </div>
    </section>
  
    <!-- About Section -->
    <section class="container py-5">
      <div class="row">
        <!-- Left Column: Specializations, Achievements, etc. -->
        <div class="col-md-6" data-aos="fade-right">
          <h2>About  ${doctorDetails.name}</h2>
          <p class="lead">
            Dedicated to offering the highest level of personalized care for every Client.
          </p>
  
          <!-- Specializations -->
          <h4>Specializations:</h4>
          <ul class="list-group list-group-flush mb-3">
            ${specializationList.map(spec => `
              <li class="list-group-item">
                <i class="bi bi-check-circle-fill"></i>
                ${spec}
              </li>
            `).join('')}
          </ul>
  
          <!-- Achievements -->
          <h4>Achievements:</h4>
          <ul class="list-group list-group-flush mb-3">
            ${achievementsList.map(ach => `
              <li class="list-group-item">
                <i class="bi bi-star-fill"></i>
                ${ach}
              </li>
            `).join('')}
          </ul>
  
          <!-- Description -->
          <h4 class="mb-2">Description:</h4>
          <div class="description-box">
            ${descriptionText}
          </div>
        </div>
  
        <!-- Right Column: Image -->
        <div class="col-md-6 text-center" data-aos="fade-left">
          <img src="${mainImage}" alt="Photo of  ${doctorDetails.name}" class="img-fluid rounded shadow">
        </div>
      </div>
    </section>
  
    <!-- CTA Section -->
    <section class="cta-section" data-aos="fade-up">
      <div class="container">
        <h2>Experience Our World-Class Services</h2>
        <p class="mb-4">Book an appointment and discover the difference of dedicated, Client-centered care.</p>
        <button class="btn-cta" onclick="document.getElementById('appointment').scrollIntoView({ behavior: 'smooth' });">
          Book Now
        </button>
      </div>
    </section>
  
    <!-- Testimonial Carousel -->
    <section class="testimonial-carousel container py-5" data-aos="fade-up">
      <h2 class="text-center mb-4">What Our Clients Say</h2>
      <div id="carouselExample" class="carousel slide" data-bs-ride="carousel">
        <div class="carousel-inner">
          <!-- Slide 1 -->
          <div class="carousel-item active">
            <div class="text-center">
              <img src="${t1}" alt="Client 1">
              <blockquote class="blockquote mt-3">
                " ${doctorDetails.name} is simply the best. I felt cared for from the moment I walked in!"
              </blockquote>
              <p class="fw-bold">- Happy Client</p>
            </div>
          </div>
          <!-- Slide 2 -->
          <div class="carousel-item">
            <div class="text-center">
              <img src="${t2}" alt="Client 2">
              <blockquote class="blockquote mt-3">
                "I wouldn't trust anyone else with my family's needs."
              </blockquote>
              <p class="fw-bold">- Satisfied Family</p>
            </div>
          </div>
          <!-- Slide 3 -->
          <div class="carousel-item">
            <div class="text-center">
              <img src="${t3}" alt="Client 3">
              <blockquote class="blockquote mt-3">
                "Professional, caring, and highly experienced. 10/10 recommend!"
              </blockquote>
              <p class="fw-bold">- Grateful Client</p>
            </div>
          </div>
        </div>
        <!-- Carousel Controls -->
        <button class="carousel-control-prev" type="button" data-bs-target="#carouselExample" data-bs-slide="prev">
          <span class="carousel-control-prev-icon" aria-hidden="true"></span>
        </button>
        <button class="carousel-control-next" type="button" data-bs-target="#carouselExample" data-bs-slide="next">
          <span class="carousel-control-next-icon" aria-hidden="true"></span>
        </button>
      </div>
    </section>
  
    <!-- FAQ Section -->
    <section class="faq-section container" data-aos="fade-up">
      <h2 class="text-center mb-4">Frequently Asked Questions</h2>
      <div class="accordion" id="faqAccordion">
        ${faqs.map((faq, index) => `
          <div class="accordion-item">
            <h2 class="accordion-header" id="heading${index}">
              <button class="accordion-button collapsed" type="button" data-bs-toggle="collapse"
                data-bs-target="#collapse${index}" aria-expanded="false" aria-controls="collapse${index}">
                ${faq.question}
              </button>
            </h2>
            <div id="collapse${index}" class="accordion-collapse collapse"
                 aria-labelledby="heading${index}" data-bs-parent="#faqAccordion">
              <div class="accordion-body">
                ${faq.answer}
              </div>
            </div>
          </div>
        `).join('')}
      </div>
    </section>
  
    <!-- Appointment Form (Scroll Target) -->
    <section class="contact-section" id="appointment">
      <div class="container" data-aos="fade-up">
        <h2 class="text-center mb-5">Request an Appointment</h2>
        <div class="row justify-content-center">
          <div class="col-md-8">
            <div class="card appointment-card">
              <div class="card-body">
                <h4 class="card-title mb-3">Please fill in your details</h4>
                <form>
                  <div class="mb-3">
                    <label for="name" class="form-label">Full Name</label>
                    <input type="text" class="form-control" id="name" placeholder="Your name" required>
                  </div>
                  <div class="mb-3">
                    <label for="email" class="form-label">Email Address</label>
                    <input type="email" class="form-control" id="email" placeholder="name@example.com" required>
                  </div>
                  <div class="mb-3">
                    <label for="date" class="form-label">Preferred Date</label>
                    <input type="date" class="form-control" id="date" required>
                  </div>
                  <div class="mb-3">
                    <label for="notes" class="form-label">Additional Notes</label>
                    <textarea class="form-control" id="notes" rows="3" placeholder="Any special requests or questions..."></textarea>
                  </div>
                  <button type="submit" class="btn btn-primary px-4">Submit</button>
                </form>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  
    <!-- Footer -->
    <footer>
      <div class="container">
        <p class="mb-2">&copy; ${new Date().getFullYear()}  ${doctorDetails.name}. All rights reserved.</p>
        <p>Setting the gold standard in personalized healthcare for every walk of life.</p>
      </div>
    </footer>
  
    <!-- Bootstrap JS bundle -->
    <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
    <!-- AOS Library JS -->
    <script src="https://cdn.jsdelivr.net/npm/aos@2.3.1/dist/aos.js"></script>
    <script>
      AOS.init({
        duration: 1000,
        once: true
      });
    </script>
  </body>
  </html>
    `;
    return html;
  }
  
  // ----------------------------------------------------
  // 4) NATURAL LANGUAGE -> LLM -> JSON -> (Compress) -> Deploy
  //    Now reads netlify site ID from request headers too
  // ----------------------------------------------------
  app.post("/nl-generate-landing-page", async (req, res) => {
    try {
      const { textPrompt } = req.body;
      if (!textPrompt) {
        return res.status(400).json({ error: 'Missing "textPrompt" field' });
      }
  
      // Extract Netlify auth token and site ID from the request headers
      const netlifyAuthToken = req.headers["netlify-auth-token"];
      const netlifySiteId    = req.headers["netlify-site-id"];
  
      if (!netlifyAuthToken) {
        return res.status(400).json({ error: "Missing 'netlify-auth-token' header" });
      }
      if (!netlifySiteId) {
        return res.status(400).json({ error: "Missing 'netlify-site-id' header" });
      }
  
      // 1) System instructions for the LLM about how to parse
      const systemMessage = `You are a helpful assistant that converts unstructured text into a JSON object 
  with the following structure exactly:
  
  {
    "websiteNiche": string, 
    "doctorDetails": {
      "name": string,
      "specialization": [array of strings],
      "achievements": [array of strings],
      "description": string
    },
    "pageLinks": [array of strings],
    "images": [array of strings],
    "testimonialImages": [array of strings],
    "faqs": [ { "question": string, "answer": string }, ... ]
  }
  
  Return ONLY valid JSON, with NO extra text or explanation.
  If any field is missing from user prompt, guess or fill placeholders.
  ALWAYS respond with valid JSON. No code blocks, no extra text.
  `;
  
      // 2) Build user message
      const userMessage = `User prompt:\n${textPrompt}\n\nPlease extract into the required JSON.`;
  
      // 3) Call OpenAI
      console.log("/nl-generate-landing-page: calling openai createChatCompletion...");
      const chatResponse = await openai.createChatCompletion({
        model: "gpt-3.5-turbo",
        messages: [
          { role: "system", content: systemMessage },
          { role: "user", content: userMessage },
        ],
        temperature: 0,
      });
  
      const rawAssistantReply = chatResponse.data.choices[0].message.content;
      console.log("/nl-generate-landing-page: rawAssistantReply =\n", rawAssistantReply);
  
      // 4) Attempt to parse JSON
      let parsed;
      try {
        parsed = JSON.parse(rawAssistantReply);
      } catch (e) {
        console.error("OpenAI JSON parse error:", e);
        return res
          .status(500)
          .send("LLM did not return valid JSON:\n" + rawAssistantReply);
      }
  
      // 4.5) For each image in parsed.images + parsed.testimonialImages => compress+upload
      if (Array.isArray(parsed.images)) {
        for (let i = 0; i < parsed.images.length; i++) {
          const originalUrl = parsed.images[i];
          try {
            const newUrl = await fetchCompressUpload(originalUrl);
            parsed.images[i] = newUrl; // replace with new Cloudinary URL
          } catch (err) {
            console.log("Error compressing image:", originalUrl, err.message);
            // fallback to original
          }
        }
      }
      if (Array.isArray(parsed.testimonialImages)) {
        for (let j = 0; j < parsed.testimonialImages.length; j++) {
          const originalTUrl = parsed.testimonialImages[j];
          try {
            const newTUrl = await fetchCompressUpload(originalTUrl);
            parsed.testimonialImages[j] = newTUrl;
          } catch (err) {
            console.log("Error compressing testimonial image:", originalTUrl, err.message);
            // fallback to original
          }
        }
      }
  
      // 5) Generate HTML from that JSON
      const finalHtml = generateLandingPageHtml(parsed);
  
      // 6) Deploy the HTML to Netlify (passing both token + site ID)
      const netlifyUrl = await deployHtmlToNetlify(finalHtml, netlifyAuthToken, netlifySiteId);
  
      // 7) Return the Netlify URL
      return res.status(200).json({
        success: true,
        netlifyUrl,
        note: "Images compressed & uploaded to Cloudinary, then deployed to Netlify (token + site ID from headers).",
      });
    } catch (err) {
      console.error("Error in /nl-generate-landing-page:", err);
      return res.status(500).json({ error: "Error processing natural language prompt" });
    }
  });

// 4️⃣ Start the server
app.listen(PORT, () => {
  console.log(`\n✅ Server running on http://localhost:${PORT}`);
  console.log(`Send a POST request to /deploy with JSON like: { "url": "https://example.com" }`);
  
});
