const express = require("express");
const schedule = require("node-schedule");
const cors = require("cors");
const fs = require("fs").promises;
const QRCode = require("qrcode");
const { Client, LocalAuth } = require("whatsapp-web.js");
const http = require("http");
const { Server } = require("socket.io");

require("dotenv").config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

const activeJobs = new Map();
let qrCode = null;
let connectionStatus = "disconnected";

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// WhatsApp Client Setup
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    executablePath: "/usr/bin/chromium-browser",
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--single-process",
      "--disable-gpu",
    ],
  },
  webVersionCache: {
    type: "remote",
    remotePath: `https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/${process.env.WWEB_VERSION}.html`,
  },
});

// Helper Functions
const phoneNumberFormatter = (number) => {
  let formatted = number.replace(/\D/g, "");
  if (formatted.startsWith("0")) {
    formatted = "62" + formatted.substr(1);
  }
  return formatted.endsWith("@c.us") ? formatted : formatted + "@c.us";
};

function validateScheduleData(schedules) {
  if (!Array.isArray(schedules)) {
    throw new Error("Input must be an array.");
  }
  schedules.forEach((schedule) => {
    if (!schedule.time || !schedule.phone || !schedule.message) {
      throw new Error("Missing required fields: time, phone, or message.");
    }
  });
  return true;
}

async function logMessageToFile(logData) {
  const logFilePath = "./logs.json";
  try {
    let logs = [];
    if (await fs.stat(logFilePath).catch(() => false)) {
      const fileContent = await fs.readFile(logFilePath, "utf8");
      const parsedData = JSON.parse(fileContent);
      if (Array.isArray(parsedData)) logs = parsedData;
    }
    const now = new Date().toLocaleString("en-US", {
      timeZone: "Asia/Makassar",
      hour12: false,
    });
    logs.push({ ...logData, date: now });
    await fs.writeFile(logFilePath, JSON.stringify(logs, null, 2), "utf8");
    console.log(":: Logs created");
  } catch (error) {
    console.error(":: Error logging:", error);
  }
}

function scheduleMessage(scheduleData) {
  try {
    const key = `${scheduleData.phone}-${scheduleData.time}`;

    if (activeJobs.has(key)) {
      console.log(`:: Job for ${key} already scheduled, skipping.`);
      return;
    }

    const job = schedule.scheduleJob(scheduleData.time, async () => {
      const payload = {
        phone: phoneNumberFormatter(scheduleData.phone),
        message: scheduleData.message,
      };

      try {
        const response = await client.sendMessage(
          payload.phone,
          payload.message
        );
        console.log(
          `:: Process to send: ${scheduleData.phone} at ${scheduleData.time}`
        );
        activeJobs.delete(key);

        await logMessageToFile({
          status: "sent",
          messageId: response.id._serialized,
        });
      } catch (error) {
        console.error(
          `Failed to send to: ${scheduleData.phone}:`,
          error.message
        );
        await logMessageToFile({
          phone: scheduleData.phone,
          status: "failed",
          error: error.message,
        });
      }
    });
    activeJobs.set(key, job);
    console.log(`:: Scheduled job for ${key}`);
  } catch (error) {
    console.error(":: Error scheduling job:", error.message);
  }
}

// WhatsApp Client Events
client.on("qr", async (qr) => {
  qrCode = qr;
  try {
    const qrCodeUrl = await QRCode.toDataURL(qr);
    io.emit("qr-code", { qrCode: qrCodeUrl });
    io.emit("connection-status", { status: "waiting-for-scan" });
    console.log(":: Generate QR Code");
  } catch (error) {
    console.error(":: Error generating QR Code:", error);
  }
});

client.on("authenticated", () => {
  connectionStatus = "authenticated";
  io.emit("connection-status", { status: "authenticated" });
  console.log(":: Authenticated");
});

client.on("ready", () => {
  connectionStatus = "ready";
  io.emit("connection-status", { status: "ready" });
  console.log(":: Whatsapp Ready");
});

client.on("auth_failure", () => {
  connectionStatus = "failed";
  io.emit("connection-status", { status: "failed" });
  console.log(":: Authentication Failed");
});

client.on("disconnected", () => {
  connectionStatus = "disconnected";
  io.emit("connection-status", { status: "disconnected" });
  console.log(":: Disconnected");
});

// Routes
app.get("/", (req, res) => {
  res.sendFile(__dirname + "/index.html");
});

app.get("/current-status", (req, res) => {
  res.status(200).json({ status: connectionStatus });
});

app.post("/schedule", async (req, res) => {
  try {
    const schedules = req.body;

    validateScheduleData(schedules);

    schedules.forEach((scheduleData) => {
      scheduleMessage(scheduleData);
    });

    res.status(200).json({ message: "Schedule created.", data: schedules });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/send-message", async (req, res) => {
  const { phone, message } = req.body;
  try {
    const formattedNumber = phoneNumberFormatter(phone);
    const isRegistered = await client.isRegisteredUser(formattedNumber);
    if (!isRegistered) {
      await logMessageToFile({
        status: "failed",
        reason: "number_not_registered",
        timestamp: new Date().toISOString(),
      });
      return res.status(404).json({
        status: false,
        message: "The phone number is not registered on WhatsApp",
      });
    }
    const response = await client.sendMessage(formattedNumber, message);

    await logMessageToFile({
      status: "sent",
      messageId: response.id._serialized,
    });

    res.status(200).json({
      status: true,
      message: "Message sent successfully",
      response: response.id._serialized,
    });

    console.log(":: Delivered:", response.id._serialized);
  } catch (error) {
    await logMessageToFile({
      phone: phoneNumberFormatter(phone),
      status: "failed",
      error: error.message,
    });
    res.status(500).json({
      status: false,
      message: "Failed to send message",
      error: error.message,
    });
  }
});

app.get("/logs", async (req, res) => {
  const logFilePath = "./logs.json";

  try {
    if (await fs.stat(logFilePath).catch(() => false)) {
      const logs = JSON.parse(await fs.readFile(logFilePath, "utf8"));
      res.status(200).json(logs);
    } else {
      res.status(200).json([]);
    }
  } catch (error) {
    console.error(":: Error reading logs:", error);
    res.status(500).json({ error: "Failed to read logs" });
  }
});

// Initialize and Start Server
client.initialize();
const PORT = process.env.PORT || 9000;

server.listen(PORT, () => {
  console.log(`:: Running on port ${PORT}`);
});
