const puppeteer = require("puppeteer");
const cheerio = require("cheerio");
const mongoose = require("mongoose");
const XLSX = require("xlsx");

// MongoDB connection
mongoose.connect("mongodb://localhost:27017/idealo_scraper");

// Mongoose Schema
const productSchema = new mongoose.Schema(
  {
    productUrl: { type: String, unique: true, required: true },
    offers: [
      {
        shopName: String,
        price: String,
        shopLink: String,
      },
    ],
    lastUpdated: { type: Date, default: Date.now },
  },
  { timestamps: true }
);
const Product = mongoose.model("Product", productSchema);

// User-Agent List
const userAgentList = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.212 Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 14_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.1 Mobile/15E148 Safari/604.1",
];

// Read URLs from Excel
const readUrlsFromExcel = (filePath) => {
  const workbook = XLSX.readFile(filePath);
  const urls = [];
  workbook.SheetNames.forEach((sheetName) => {
    const sheet = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);
    sheet.forEach((row) => {
      if (row.URL) urls.push(row.URL);
    });
  });
  return urls;
};

// Helper function to get a random user agent
const getRandomUserAgent = () => {
  return userAgentList[Math.floor(Math.random() * userAgentList.length)];
};

// Helper function to resolve URLs
const resolveUrl = (baseUrl, relativeOrAbsoluteUrl) => {
  return relativeOrAbsoluteUrl.startsWith("http")
    ? relativeOrAbsoluteUrl
    : `${baseUrl}${relativeOrAbsoluteUrl}`;
};

// Scrape product details
const scrapeProductDetails = async (url, browser) => {
  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({
    "user-agent": getRandomUserAgent(),
  });

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 0 });

    // Wait for the offer elements to load
    await page.waitForSelector("a.productOffers-listItemOfferLink", {
      timeout: 10000,
    });

    // Extract data
    const offers = await page.evaluate(() => {
      const data = [];
      document
        .querySelectorAll("a.productOffers-listItemOfferLink")
        .forEach((offer) => {
          const shopNameRaw = offer.getAttribute("data-shop-name") || "N/A";
          const shopName = shopNameRaw.includes(".")
            ? shopNameRaw.split(".")[0].trim() // Truncate at the first dot
            : shopNameRaw.trim();
          const priceMatch = offer
            .getAttribute("href")
            ?.match(/price=([\d.]+)/);
          const price = priceMatch ? `£${priceMatch[1]}` : "N/A";
          const shopLink = offer.href || "N/A";

          data.push({ shopName, price, shopLink });
        });
      return data;
    });

    return offers.map((offer) => ({
      ...offer,
      shopName: offer.shopName.replace(/[^a-zA-Z0-9 ]/g, ""), // Further clean shopName
    }));
  } catch (error) {
    console.error(`Error scraping product details for ${url}:`, error.message);
    return [];
  } finally {
    await page.close();
  }
};

// Scrape product listing page
const scrapeListingPage = async (url, browser) => {
  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({
    "user-agent": getRandomUserAgent(),
  });

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 0 });

    // Extract product links
    const productLinks = await page.evaluate(() => {
      const links = [];
      document
        .querySelectorAll('div[data-testid="resultItem"] a[data-testid]')
        .forEach((product) => {
          links.push(product.href);
        });
      return links;
    });

    // Handle pagination
    const nextPage = await page.evaluate(() => {
      const nextButton = document.querySelector('a[aria-label="next page"]');
      return nextButton ? nextButton.href : null;
    });

    return { productLinks, nextPage };
  } catch (error) {
    console.error(`Error scraping listing page for ${url}:`, error.message);
    return { productLinks: [], nextPage: null };
  } finally {
    await page.close();
  }
};

// Save data to MongoDB
const saveToDatabase = async (productUrl, offers) => {
  try {
    const existingProduct = await Product.findOne({ productUrl });
    if (existingProduct) {
      // Update existing document
      existingProduct.offers = offers;
      existingProduct.lastUpdated = new Date();
      await existingProduct.save();
      console.log(`Updated product: ${productUrl}`);
    } else {
      // Insert new document
      await Product.create({ productUrl, offers });
      console.log(`Inserted new product: ${productUrl}`);
    }
  } catch (error) {
    console.error(`Error saving data for ${productUrl}:`, error.message);
  }
};

// Main function to scrape all pages
const scrapeAll = async (urls) => {
  const browser = await puppeteer.launch({ headless: true });

  for (const url of urls) {
    console.log(`Scraping category: ${url}`);

    let nextPage = url;
    while (nextPage) {
      const { productLinks, nextPage: nextListingPage } =
        await scrapeListingPage(nextPage, browser);
      nextPage = nextListingPage;

      for (const productUrl of productLinks) {
        console.log(`Scraping product: ${productUrl}`);
        const offers = await scrapeProductDetails(productUrl, browser);
        await saveToDatabase(productUrl, offers);
      }
    }
  }

  await browser.close();
};

// Read input and scrape
(async () => {
  const inputFilePath = "./Idealo Scrape UK.xlsx";

  const urls = readUrlsFromExcel(inputFilePath);
  await scrapeAll(urls);

  console.log("Scraping completed.");
  mongoose.connection.close();
})();
